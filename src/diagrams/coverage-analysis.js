export const PAYROLL_COVERAGE_DIAGRAM = `sequenceDiagram
  participant Tool as Coverage Tool
  participant Truv as Truv API
  Note over Tool: Read CSV (name, state, domain)
  loop For each row (concurrency 5, retry on 429)
    Tool->>Truv: POST /v1/companies/
    Note right of Tool: { name, domain, state, product_type }
    Truv-->>Tool: { company_mapping_id, name, domain,<br/>logo_url, success_rate, mapping_status }
  end
  Note over Tool: Write results CSV<br/>(matched company, logo, success_rate, mapping_status)`;

export const BANK_COVERAGE_DIAGRAM = `sequenceDiagram
  participant Tool as Coverage Tool
  participant Truv as Truv API
  Note over Tool: Read CSV (name, domain)
  loop For each row (concurrency 5, retry on 429)
    Tool->>Truv: GET /v1/providers/?query=...&data_source=financial_accounts
    Truv-->>Tool: { results: [{ id, name, domain, logo_url, ... }] }
  end
  Note over Tool: Write results CSV`;
