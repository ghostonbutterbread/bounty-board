# Finding class and severity cleanup proposal (not applied)

- Status: proposal for owner review. No data was changed. The Board only normalizes at display time.
- Companion: `docs/integrations/taxonomy-coverage.md` (implementation and evidence).

## What the read-only inventory found

Counts are from a read-only scan of the real web and binaries ledgers (361 finding records, 39 ledgers). Raw inventories stay outside the repo.

| Field | Finding | Count |
|---|---|---|
| severity | Canonical enum value (incl. UNKNOWN) | 329 |
| severity | Template placeholder `LOW\|MEDIUM\|HIGH\|CRITICAL` (never filled in) | 28 |
| severity | Alias that BBH now normalizes at write time (`P2`, `INFORMATIONAL`) | 2 |
| severity | Range `LOW-MEDIUM` | 1 |
| severity | `NONE` | 1 |
| severity | `UNKNOWN` (already canonical, but 92 records, 25%, have no rating) | 92 |
| class_name | Distinct labels | 143 |
| class_name | `unknown` or `novel` placeholder | 52 |
| class_name | Markdown-heading style labels (`**-...`, long CWE lists, free sentences) | dozens |
| class_name | Agent or hunter names used as a class (`...-hunter`, `...-auditor`, product-prefixed lane names) | dozens |
| class_name | Same idea, different spelling (`access-control`, `broken-access-control`, `authorization`, `authz`) | many |

The existing `type` field also contains placeholders (`short vulnerability label`, 26 records) and report headings. `type` was not normalized here.

## Proposed canonical mappings (for approval)

Rules live in `static/taxonomy-rules.json`; this table is the human-readable summary. A mapped label is a proposal for a display category, not a verdict about the finding.

| Category | Subclasses | Typical raw labels folded in |
|---|---|---|
| Broken Access Control | IDOR / object-level; Privilege escalation; Missing or bypassable authorization | idor, bola, object-level/object-binding/ownership/tenant authorization, access-control, authz, authorization bypass, vertical privilege escalation |
| Authentication and Session | Broken auth; Missing auth; Account takeover; OAuth/SSO; MFA; Session management; Token/JWT; Brute force; Enumeration | ato, password reset, broken-authentication, session expiration/invalidation, jwt, oauth redirect, account enumeration |
| Cross-Site Scripting | Stored; Reflected; DOM; Unspecified | stored-xss, dom-xss, cross-site-scripting (stored) |
| Server-Side Injection | SQLi; SSTI; Command; XXE; Parameter; Input validation | sql-injection, command-injection, parameter-injection |
| Client-Side Injection | Prototype pollution; CSS; CSV formula | prototype-pollution, css-injection, csv-formula-injection |
| Remote Code Execution | Deserialization; AI agent or sandbox; Exec sink; Other | unsafe-deserialization, ai-sandbox-rce, exec-sink-reachability |
| Server-Side Request Forgery | | ssrf, server-side-request-forgery |
| Sensitive Data Exposure | Information disclosure; Secrets; Source/config disclosure | information-disclosure, info-disclosure, hardcoded credentials, secrets-exposure |
| Security Misconfiguration | CORS; Security control bypass; Subdomain takeover; Error handling; Environment | cors, dangling DNS, allowlist bypass, environment-confusion |
| Business Logic | Race condition; Payment; Workflow | race, toctou, business-logic, payment-testing |
| CSRF, Open Redirect, Denial of Service, Memory Safety | | csrf, open-redirect, denial-of-service, memory-unsafe-parser |
| File Handling | Path traversal; Upload | path-traversal, upload |
| Insecure Application Integration | IPC/RPC; Deep link/protocol; WebView/native; Debug surface | ipc, deep link, custom protocol, node-integration, native-module-abuse, cdp-debug-port |
| AI Feature Security | Prompt injection; Indirect; Agent/tool abuse | prompt-injection, indirect-prompt-injection |
| Unclassified | | unknown, novel, tool/agent names with no class keyword; raw label always shown |

Decisions needed from Ryu:

1. **Compound labels.** `broken-access-control -> information-disclosure` resolves to the first matching rule (access control) and lists the other category as an alternate. Approve the rule order, or choose a primary-impact rule instead.
2. **Agent names as classes.** Labels such as `*-hunter` and product-prefixed lane names are not vulnerability classes. Proposal: keep them Unclassified or low-confidence, and fix at the source (agent should write a class, put its own name in a tag).
3. **`P0`.** BBH maps P0 to UNKNOWN. The Board follows BBH. Decide in BBH if P0 should be CRITICAL.
4. **`UNKNOWN` severity (25% of records)** is a rating backlog, not a mapping problem. It needs triage by a person.
5. **Placeholder `LOW|MEDIUM|HIGH|CRITICAL` (28 records)** is template text. Proposal: treat as unrated.
6. **Ranges** (`LOW-MEDIUM`): proposal is to keep UNKNOWN until one rating is chosen, not to pick the lower or higher end.

## How an approved cleanup would be applied later (not now)

1. Export a reviewed mapping CSV from the rules file: `fid, lane, raw_class, proposed_category, proposed_class_name, confidence`. Only rows Ryu marks approved are applied; low-confidence and Unclassified rows are never bulk applied.
2. Apply through BBH only, never by editing `ledger.json`: one `me_ledger.py` update per finding using the existing metadata write path (the same one the Board uses for `class_name`, `severity`, `severity_rationale`). Severity rating goes through `normalize_severity`.
3. Preserve provenance: before writing, store the old raw value in a note or rationale (`class_name was "<raw>" before cleanup <date>`), and keep the pre-change export as the audit record. The Board's `metadata_revision` check gives per-record conflict detection.
4. Dry run first (diff only), then a small batch (10 records), then review in the Board, then the rest. Writers stopped while a batch runs.
5. Report the result as counts only (changed, skipped, conflicts).
