/**
 * FILE SUMMARY:
 * Root router and demo registry for the Truv demo-apps frontend.
 * Defines all available demos grouped by industry, provides hash-based
 * routing, and renders the correct component for each URL.
 *
 * DATA FLOW:
 * Browser (hash change) -> App component (parseHash) -> route state ->
 *   renders Home, IndustryPage, or a specific Demo component.
 * Demo components call navigate() to transition between screens, which
 *   updates window.location.hash and triggers a re-render cycle.
 *
 * Hash URL structure:
 *   #                                        -> Home (industry picker)
 *   #consumer-credit                         -> IndustryPage (list of demos)
 *   #consumer-credit/smart-routing           -> Demo intro screen
 *   #consumer-credit/smart-routing/bridge/id -> Demo active screen
 *
 * Each demo component receives { screen, param } props from the router.
 * See SmartRouting.jsx for the Consumer Credit pattern (Bridge flow)
 * and POSApplication.jsx for the Mortgage pattern (Orders flow).
 */

// Imports: Preact hooks, page-level components, and all demo components.
import { useState, useEffect } from 'preact/hooks';
import { Home } from './Home.jsx';
import { IndustryPage } from './IndustryPage.jsx';
import { POSApplicationDemo } from './demos/POSApplication.jsx';
import { POSTasksDemo } from './demos/POSTasks.jsx';
import { CaseWorkerPortalDemo } from './demos/CaseWorkerPortal.jsx';
import { DocumentProcessingDemo } from './demos/DocumentProcessing.jsx';
import { LOSDemo } from './demos/LOS.jsx';
import { CustomerPortalDemo } from './demos/CustomerPortal.jsx';
import { PSDocumentProcessingDemo } from './demos/PSDocumentProcessing.jsx';
import { SmartRoutingDemo } from './demos/SmartRouting.jsx';
import { BankIncomeDemo } from './demos/BankIncome.jsx';
import { PayrollIncomeDemo } from './demos/PayrollIncome.jsx';
import { PaycheckLinkedLoansDemo } from './demos/PaycheckLinkedLoans.jsx';
import { DirectDepositSwitchDemo } from './demos/DirectDepositSwitch.jsx';
import { PayrollCoverageDemo } from './demos/PayrollCoverage.jsx';
import { BankCoverageDemo } from './demos/BankCoverage.jsx';
import { LionPosPage } from './pages/LionPos.jsx';

// INDUSTRIES registry: each entry has an id, display name, description, and a
// demos array. Each demo object maps { id, name, component, desc, tags } so
// the router can resolve a hash URL to a component and the UI can render cards.
export const INDUSTRIES = [
  {
    id: 'mortgage',
    name: 'Mortgage',
    desc: 'Verify borrower income, employment, and assets in minutes with GSE-certified reports for Day 1 Certainty.',
    demos: [
      { id: 'pos-application', name: 'POS Application', component: POSApplicationDemo, desc: 'A borrower fills out a loan application and verifies their income or employment in real time, right inside the point-of-sale.', tags: ['Company Search', 'Orders', 'Bridge', 'Reports'] },
      { id: 'pos-tasks', name: 'POS Tasks', component: POSTasksDemo, desc: 'After submitting a loan application, the borrower returns to complete remaining verifications: income, employment, and assets.', tags: ['Orders', 'Bridge', 'VOIE', 'VOE', 'Assets'] },
      { id: 'los', name: 'LOS', component: LOSDemo, desc: 'A Loan Processor creates verification orders from the LOS using borrower data on file. Borrowers receive a link to complete verification on their own.', tags: ['Orders', 'Share URL', 'Status Tracking', 'Reports'] },
      { id: 'documents', name: 'Document Processing', component: DocumentProcessingDemo, desc: 'Process pay stubs, W-2s, and tax returns already collected. Truv validates the documents and extracts structured income data for underwriting.', tags: ['Document Collections', 'Finalize', 'Parsed Data'] },
    ],
  },
  {
    id: 'public-sector',
    name: 'Public Sector',
    desc: 'Instant income and employment verification for benefit eligibility, program enrollment, and recertification.',
    demos: [
      { id: 'customer-portal', name: 'Customer Portal', component: CustomerPortalDemo, desc: 'An applicant applies for benefits and verifies their income and employment through a self-service portal.', tags: ['Company Search', 'Orders', 'Bridge', 'Reports'] },
      { id: 'documents', name: 'Document Processing', component: PSDocumentProcessingDemo, desc: 'Process pay stubs, W-2s, and tax returns to verify income for benefit eligibility decisions.', tags: ['Document Collections', 'Finalize', 'Parsed Data'] },
      { id: 'verifier-portal', name: 'Case Worker Portal', component: CaseWorkerPortalDemo, desc: 'A Case Worker creates verification orders using applicant data on file and sends verification links via email or SMS.', tags: ['Orders', 'Share URL', 'Status Tracking', 'Reports'] },
    ],
  },
  {
    id: 'consumer-credit',
    name: 'Consumer Credit',
    desc: 'Approve more borrowers with instant income and asset verification. Reduce fraud and speed up decisioning.',
    demos: [
      { id: 'smart-routing', name: 'Smart Routing', component: SmartRoutingDemo, desc: 'Check the applicant\'s employer coverage and automatically recommend the best verification method: payroll, bank, or documents.', tags: ['Company Search', 'success_rate', 'data_sources', 'Bridge'] },
      { id: 'bank-income', name: 'Bank Income', component: BankIncomeDemo, desc: 'Verify applicant income from bank transactions when payroll data isn\'t available.', tags: ['financial_accounts', 'Bridge', 'Income Insights'] },
      { id: 'payroll-income', name: 'Payroll Income', component: PayrollIncomeDemo, desc: 'Verify income and employment directly from payroll data for fast lending decisions.', tags: ['payroll', 'Bridge', 'VOIE Report'] },
      { id: 'pll', name: 'Paycheck-Linked Loans', component: PaycheckLinkedLoansDemo, desc: 'Set up automatic loan repayment through payroll deductions. Verify income and configure the deduction in one flow.', tags: ['pll', 'Bridge', 'Payroll Deductions'] },
    ],
  },
  {
    id: 'retail-banking',
    name: 'Retail Banking',
    desc: 'Acquire deposits and enable paycheck-linked lending with direct payroll connections.',
    demos: [
      { id: 'deposit-switch', name: 'Direct Deposit Switch', component: DirectDepositSwitchDemo, desc: 'Switch a customer\'s direct deposit to your bank through their payroll provider. Changes take effect on the next pay cycle.', tags: ['deposit_switch', 'Bridge', 'Payroll'] },
    ],
  },
  {
    id: 'coverage-analysis',
    name: 'Coverage Analysis',
    desc: 'Bulk-check Truv coverage for thousands of employers or financial institutions in one upload. Rate-limited and retried so you can run an entire book of business in minutes.',
    demos: [
      { id: 'payroll-coverage', name: 'Payroll Coverage', component: PayrollCoverageDemo, desc: 'Upload a CSV of up to 10,000 employers and see which ones Truv supports for income, employment, deposit-switch, or paycheck-linked-loans.', tags: ['Bulk', 'companies', 'CSV', 'Rate-limited'] },
      { id: 'bank-coverage', name: 'Financial Accounts Coverage', component: BankCoverageDemo, desc: 'Upload a CSV of up to 10,000 financial accounts and see which ones Truv can connect to for transactions or assets data.', tags: ['Bulk', 'providers', 'financial_accounts', 'CSV'] },
    ],
  },
];

// Parse the URL hash into route segments.
// e.g. "#consumer-credit/smart-routing/bridge/abc123"
//   -> { industry: "consumer-credit", demo: "smart-routing", screen: "bridge", param: "abc123" }
function parseHash() {
  const hash = window.location.hash.slice(1);
  const [industry, demo, screen, ...rest] = hash.split('/');
  return { industry: industry || '', demo: demo || '', screen: screen || '', param: rest.join('/') || '' };
}

// Navigation helper: demo components call this to transition between screens.
// Updates the hash, which triggers a hashchange event and re-render.
// Example: navigate('consumer-credit/smart-routing/waiting/abc123')
export function navigate(path) {
  window.location.hash = path;
}

// App component: top-level router. Listens for hashchange events, parses
// the hash into route segments, and renders the matching view.
export function App() {
  // Route state: re-parsed on every hashchange event.
  const [route, setRoute] = useState(parseHash);

  // Effect: subscribe to hashchange so navigation triggers re-renders.
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Routing logic: progressively resolve industry, then demo, then screen.
  // At each level, fall back to the parent view if no match is found.
  if (route.industry === 'lion') return <LionPosPage />;
  if (!route.industry) return <Home />;

  const industry = INDUSTRIES.find(i => i.id === route.industry);
  if (!industry) return <Home />;

  if (!route.demo) return <IndustryPage industry={industry} />;

  const demoConfig = industry.demos.find(d => d.id === route.demo);
  if (!demoConfig) return <IndustryPage industry={industry} />;

  // Render the matched demo component with screen and param props.
  const Component = demoConfig.component;
  return <Component key={`${route.industry}/${route.demo}`} screen={route.screen} param={route.param} />;
}
