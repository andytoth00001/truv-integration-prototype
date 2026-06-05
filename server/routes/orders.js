/**
 * FILE SUMMARY: Orders CRUD routes
 * DATA FLOW: Frontend -> POST/GET /api/orders -> TruvClient -> Truv API (/v1/orders/)
 * INTEGRATION PATTERN: Orders flow (used by Mortgage / Public Sector demos)
 *
 * Manages the full lifecycle of Truv verification orders. The frontend creates
 * an order with PII and product type, this backend proxies the request to Truv,
 * stores the result in SQLite, and serves order state back to the UI on demand.
 */

// Express router factory
import { Router } from 'express';

// Utility: safely parse JSON strings from the DB without throwing
function safeParse(str) { try { return JSON.parse(str); } catch { return {}; } }

// Factory function: receives shared dependencies (TruvClient, DB, logger) and returns a configured router
export default function ordersRoutes({ truv, db, apiLogger }) {
  const router = Router();

  // GET /api/orders: List all orders, optionally filtered by demo_id.
  // Reads from SQLite only (no Truv API call). Returns parsed raw_response for each order.
  router.get('/api/orders', (req, res) => {
    try {
      const demoId = req.query.demo_id;
      const orders = demoId ? db.getOrdersByDemoId(demoId) : db.getAllOrders();
      res.json(orders.map(o => ({
        order_id: o.id, truv_order_id: o.truv_order_id, user_id: o.user_id, demo_id: o.demo_id,
        status: o.status, share_url: o.share_url, created_at: o.created_at,
        raw_response: safeParse(o.raw_response),
      })));
    } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/orders: Create a new verification order.
  // Flow: build params from request body -> POST /v1/orders/ at Truv -> store in SQLite -> return order metadata.
  // The Truv response includes a bridge_token and share_url that the frontend uses to launch Bridge.
  router.post('/api/orders', async (req, res) => {
    try {
      const data = req.body || {};
      const orderId = db.generateId();
      const pt = data.product_type || 'income';

      // Build the Truv order payload from frontend-supplied fields
      const params = {
        first_name: data.first_name, last_name: data.last_name,
        email: data.email, phone: data.phone, ssn: data.ssn,
        product_type: pt,
        products: data.products,
        external_user_id: data.external_user_id,
        employer: data.employer,
        company_mapping_id: data.company_mapping_id,
        provider_id: data.provider_id,
        data_sources: data.data_sources,
      };

      // Proxy the order creation to Truv API
      const result = await truv.createOrder(params);
      const truvData = result.data;
      if (result.statusCode >= 400) {
        console.error('Order creation failed:', JSON.stringify({ request: result.requestBody, response: truvData }));
        return res.status(result.statusCode).json({ error: 'Truv API error', details: truvData });
      }

      // Persist the order in SQLite and log the API call
      const userId = truvData.user_id;
      const loanNumber = data.loan_number || `2026-WC-${Date.now().toString().slice(-6)}`;
      db.createOrder({ orderId, truvOrderId: truvData.id, userId, demoId: data.demo_id || 'default', bridgeToken: truvData.bridge_token, shareUrl: truvData.share_url, status: truvData.status || 'created', rawResponse: truvData, loanNumber });
      db.updateOrder(orderId, { product_type: data.products ? data.products.join(',') : pt });
      apiLogger.logApiCall({ userId, method: 'POST', endpoint: '/v1/orders/', requestBody: result.requestBody, responseBody: truvData, statusCode: result.statusCode, durationMs: result.durationMs });

      // Return the minimal order info the frontend needs to proceed
      res.json({ order_id: orderId, truv_order_id: truvData.id, user_id: userId, bridge_token: truvData.bridge_token, status: truvData.status, company_mapping_id: data.company_mapping_id || null });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
  });

  // GET /api/orders/:id/info: Lightweight order lookup from SQLite only.
  // No Truv API call. Used when the frontend just needs the bridge_token or status without refreshing.
  router.get('/api/orders/:id/info', (req, res) => {
    const order = db.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order_id: order.id, truv_order_id: order.truv_order_id, user_id: order.user_id, bridge_token: order.bridge_token, status: order.status, product_type: order.product_type });
  });

  // GET /api/orders/:id: Fetch order details with a live refresh from Truv.
  // Flow: read from DB -> GET /v1/orders/:truv_order_id/ -> update DB with latest status -> return to frontend.
  router.get('/api/orders/:id', async (req, res) => {
    try {
      let order = db.getOrder(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const userId = order.user_id;

      // If the order has a Truv ID, fetch the latest state from the Truv API and update the DB
      if (order.truv_order_id) {
        const result = await truv.getOrder(order.truv_order_id);
        apiLogger.logApiCall({ userId, method: 'GET', endpoint: `/v1/orders/${order.truv_order_id}/`, responseBody: result.data, statusCode: result.statusCode, durationMs: result.durationMs });
        if (result.statusCode >= 400) return res.status(result.statusCode).json({ error: 'Truv API error', details: result.data });
        db.updateOrder(order.id, { status: result.data.status || order.status, raw_response: result.data });
        order = db.getOrder(order.id);
      }

      const raw = order.raw_response ? JSON.parse(order.raw_response) : {};
      res.json({ order_id: order.id, truv_order_id: order.truv_order_id, user_id: userId, status: order.status, bridge_token: order.bridge_token, share_url: order.share_url, raw_response: raw });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
  });

  // Export the configured router
  return router;
}
