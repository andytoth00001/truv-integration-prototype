/**
 * FILE SUMMARY: Truv API Client
 * DATA FLOW: Backend (Express routes) --> TruvClient --> Truv REST API (api.truv.com)
 * INTEGRATION PATTERN: Used by both Orders flow and Bridge flow.
 *
 * Wraps all Truv REST API endpoints behind a single class. Express route handlers
 * call TruvClient methods instead of making raw HTTP requests. The client injects
 * API credentials (client ID + secret) into every outbound request as headers.
 */

// Dependencies: node-fetch for HTTP requests, uuid for generating unique identifiers
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';

export class TruvClient {
  // Constructor: stores API credentials and builds default headers for all requests.
  // Every outbound call to Truv includes X-Access-Client-Id and X-Access-Secret.
  constructor({ clientId, secret, apiUrl = 'https://prod.truv.com/v1/' }) {
    this.clientId = clientId;
    this.secret = secret;
    this.apiUrl = apiUrl;
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Access-Client-Id': clientId,
      'X-Access-Secret': secret,
    };
  }

  // Core HTTP helper: sends a request to the Truv API and returns a normalized
  // response object with statusCode, parsed data, timing, and the original request body.
  // All public methods delegate to this.
  async _request(method, endpoint, { json } = {}) {
    const url = this.apiUrl + endpoint;
    const start = performance.now();

    const opts = { method, headers: this.headers };
    if (json) opts.body = JSON.stringify(json);

    const response = await fetch(url, opts);
    const durationMs = Math.round((performance.now() - start) * 10) / 10;

    let data;
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    console.log(`TRUV: ${method.toUpperCase()} ${url} — ${response.status} (${durationMs}ms)`);
    return {
      statusCode: response.status,
      data,
      durationMs,
      requestBody: json || null,
      retryAfter: response.headers.get('retry-after'),
    };
  }

  // --- Users API ---
  // Creates a Truv user. In production, replace the placeholder PII with real applicant data.

  async createUser(overrides = {}) {
    const payload = {
      external_user_id: `qs-${uuidv4()}`, // Replace with your internal user/application ID
      first_name: 'John',
      last_name: 'Johnson',
      email: 'j.johnson@example.com',
      ...overrides,
    };
    return this._request('POST', 'users/', { json: payload });
  }

  // Creates a Bridge token for a Truv user. The token is used by the frontend
  // to launch the Truv Bridge widget. Optionally deeplinks to a specific employer
  // or financial institution so the user skips the search screen.
  async createUserBridgeToken(userId, productType, { data_sources, company_mapping_id, provider_id } = {}) {
    const payload = {
      product_type: productType,
      client_name: 'Truv Demo Apps',
      tracking_info: '1338-0111-A', // Replace with your internal reference (e.g. loan number)
    };

    if (data_sources && data_sources.length > 0) {
      payload.data_sources = data_sources;
    }

    // Deeplink the employer/institution so the user skips the Bridge search screen.
    // The Truv API uses different field names:
    //   - Payroll providers: company_mapping_id (from GET /v1/company-mappings-search/)
    //   - Financial institutions: provider_id (from GET /v1/providers/)
    // See: https://docs.truv.com/reference/users_tokens
    if (company_mapping_id) payload.company_mapping_id = company_mapping_id;
    if (provider_id) payload.provider_id = provider_id;

    // Sandbox test account for deposit_switch and pll products
    if (productType === 'deposit_switch' || productType === 'pll') {
      payload.account = {
        account_number: '16002600',   // Sandbox test value — replace with real account in production
        account_type: 'checking',
        routing_number: '12345678',   // Sandbox test value
        bank_name: 'Truv Bank',       // Sandbox test value
      };
      if (productType === 'pll') {
        payload.account.deposit_type = 'amount';
        payload.account.deposit_value = 100; // Numeric amount
      }
    }

    return this._request('POST', `users/${userId}/tokens/`, { json: payload });
  }

  // --- Company Search ---
  // Searches for financial institution providers. Used by the frontend search bar
  // when the product requires bank/financial account connections.

  async searchProviders(query, productType, dataSource) {
    // Note: Truv expects ?query= here (NOT ?search=). ?search= is silently ignored
    // and returns the unfiltered list of all 11k+ providers.
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (productType) params.set('product_type', productType);
    if (dataSource) params.set('data_source', dataSource);
    return this._request('GET', `providers/?${params}`);
  }

  // Searches for employer/company mappings. Used by the frontend search bar
  // when the product requires payroll connections.
  async searchCompanies(query, productType) {
    const params = new URLSearchParams({ query });
    if (productType) params.set('product_type', productType);
    return this._request('GET', `company-mappings-search/?${params}`);
  }

  // Look up a company with full identifying fields. Used by Coverage Analysis
  // for accurate coverage matching when the caller has name + domain + state.
  // POST /v1/companies/  body: { name, domain, ein, phone, id, product_type }
  // Response shape mirrors company-mappings-search: matches with logo_url,
  // success_rate, confidence_level, and mapping_status.
  async lookupCompany({ name, domain, ein, phone, id, product_type, state, address }) {
    const body = {};
    if (name) body.name = name;
    if (domain) body.domain = domain;
    if (ein) body.ein = ein;
    if (phone) body.phone = phone;
    if (id) body.id = id;
    if (product_type) body.product_type = product_type;
    if (state) body.state = state;
    if (address) body.address = address;
    return this._request('POST', 'companies/', { json: body });
  }

  // --- Orders API ---
  // Creates a Truv order. Orders are the primary integration pattern for Mortgage
  // and Public Sector demos. The payload varies based on product type: payroll
  // products use employers[], while bank/assets products use financial_institutions[].

  async createOrder(params = {}) {
    const productType = params.product_type || 'income';
    const payload = {
      order_number: `qs-${uuidv4()}`, // Replace with your internal order/application ID
      external_user_id: params.external_user_id || `qs-${uuidv4()}`,
      first_name: params.first_name || 'John',
      last_name: params.last_name || 'Johnson',
      products: params.products || [productType],
    };

    if (params.data_sources && params.data_sources.length > 0) {
      payload.data_sources = params.data_sources;
    }

    if (params.email) payload.email = params.email;
    if (params.phone) payload.phone = params.phone;
    if (params.ssn) payload.social_security_number = params.ssn;
    if (params.template_id) payload.template_id = params.template_id;

    // The Truv Orders API uses different arrays for payroll vs bank:
    //   - Payroll products: employers: [{ company_mapping_id }]
    //   - Bank/assets products: financial_institutions: [{ id, name }]
    // See: https://docs.truv.com/reference/orders_create
    // Sandbox credentials: goodlogin / goodpassword
    if (productType === 'assets' || (params.data_sources && params.data_sources.includes('financial_accounts'))) {
      if (params.provider_id || params.employer) {
        const fi = {};
        if (params.provider_id) fi.id = params.provider_id;
        if (params.employer) fi.name = params.employer;
        payload.financial_institutions = [fi];
      }
    } else {
      // Payroll products use employers: [{ company_mapping_id }]
      if (params.company_mapping_id) {
        payload.employers = [{ company_mapping_id: params.company_mapping_id }];
      } else if (params.employer) {
        payload.employers = [{ company_name: params.employer }];
      }
    }

    // Sandbox test account for deposit_switch and pll products
    if (['deposit_switch', 'pll'].includes(productType) && payload.employers) {
      payload.employers[0].account = {
        account_number: '16002600',   // Sandbox test value — replace with real account in production
        account_type: 'checking',
        routing_number: '12345678',   // Sandbox test value
        bank_name: 'Truv Bank',       // Sandbox test value
      };
      if (productType === 'pll') {
        payload.employers[0].account.deposit_type = 'amount';
        payload.employers[0].account.deposit_value = 100; // Numeric amount
      }
    }

    return this._request('POST', 'orders/', { json: payload });
  }

  // Retrieves the current state of an order by its Truv-assigned ID.
  async getOrder(truvOrderId) {
    return this._request('GET', `orders/${truvOrderId}/`);
  }

  // --- Webhooks API ---
  // CRUD operations for managing webhook registrations on the Truv platform.
  // Used by webhook-setup.js to auto-register an ngrok URL on startup.

  async listWebhooks() {
    return this._request('GET', 'webhooks/');
  }

  async createWebhook(params) {
    return this._request('POST', 'webhooks/', { json: params });
  }

  async deleteWebhook(webhookId) {
    return this._request('DELETE', `webhooks/${webhookId}/`);
  }

  // --- Token Exchange & Reports ---
  // Exchanges a public_token (from Bridge widget) for a persistent access token.
  // This is the Bridge flow handoff: Frontend receives public_token from Bridge,
  // sends it to our backend, which exchanges it for a link access token.

  async getAccessToken(publicToken) {
    return this._request('POST', 'link-access-tokens/', { json: { public_token: publicToken } });
  }

  // Fetches a report for a specific link. Used in the Bridge flow after token exchange.
  async getLinkReport(linkId, reportType) {
    return this._request('GET', `links/${linkId}/${reportType}/report/`);
  }

  // --- Reports ---
  // Report generation and retrieval endpoints. Reports are async: create returns
  // a report ID, then poll with the get method until status is complete.

  // VOIE/VOE report: is_voe=false -> income+employment, is_voe=true -> employment only
  async createVoieReport(userId, isVoe = false) {
    return this._request('POST', `users/${userId}/reports/`, { json: { is_voe: isVoe } });
  }

  async getVoieReport(userId, reportId) {
    return this._request('GET', `users/${userId}/reports/${reportId}/`);
  }

  // Assets report: creates an aggregated assets report for a user.
  async createAssetsReport(userId) {
    return this._request('POST', `users/${userId}/assets/reports/`);
  }

  async getAssetsReport(userId, reportId) {
    return this._request('GET', `users/${userId}/assets/reports/${reportId}/`);
  }

  // Income insights report: creates a report with configurable lookback period
  // and a permissible purpose declaration for compliance.
  async createIncomeInsightsReport(userId) {
    return this._request('POST', `users/${userId}/income_insights/reports/`, {
      json: { days_requested: 60, consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT' },
    });
  }

  async getIncomeInsightsReport(userId, reportId) {
    return this._request('GET', `users/${userId}/income_insights/reports/${reportId}/`);
  }

  // Deposit switch report: retrieves the report for a user's deposit switch request.
  // See: https://docs.truv.com/reference/dds-report-retrieve
  async getDepositSwitchReport(userId) {
    return this._request('GET', `users/${userId}/deposit_switch/report/`);
  }

  // --- Document Collections API ---
  // Manages document upload flows for paystub/W2 verification.
  // Workflow: create collection -> upload documents -> finalize -> poll results.

  // Creates a new document collection with initial document metadata.
  async createDocumentCollection(documents) {
    return this._request('POST', 'documents/collections/', {
      json: { documents },
    });
  }

  // Retrieves the current state of a document collection.
  async getDocumentCollection(collectionId) {
    return this._request('GET', `documents/collections/${collectionId}/`);
  }

  // Uploads additional documents to an existing collection.
  async uploadToCollection(collectionId, documents) {
    return this._request('POST', `documents/collections/${collectionId}/upload/`, {
      json: { documents },
    });
  }

  // Finalizes a collection for processing. After finalization, Truv extracts
  // data and generates a report based on the specified product type.
  async finalizeCollection(collectionId, productType = 'income') {
    return this._request('POST', `documents/collections/${collectionId}/finalize/`, {
      json: { product_type: productType },
    });
  }

  // Retrieves the income report for a specific link (used after document finalization).
  async getLinkIncomeReport(linkId) {
    return this._request('GET', `links/${linkId}/income/report/`);
  }

  // Retrieves finalization results for a document collection.
  async getFinalizationResults(collectionId) {
    return this._request('GET', `documents/collections/${collectionId}/finalize/`);
  }
}
