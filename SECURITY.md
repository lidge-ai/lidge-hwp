# Security

LIDGE HWP is a local, single-user editor. The HTTP server binds to `127.0.0.1`.
Do not expose it through a public reverse proxy, shared-host tunnel, or remote bind.
It does not provide multi-user authentication.

MCP access can change documents and commit them to the local document library.
Give access only to trusted local clients. JavaScript restrictions and the API allowlist
are not a general-purpose security sandbox for hostile users.

Keep document libraries outside this source repository. Never attach real application
forms, personal information, credentials or private documents to a public issue.
Use synthetic reproducers and inspect screenshots and logs before sharing them.

For vulnerabilities, use GitHub private vulnerability reporting when enabled:
https://github.com/lidge-ai/lidge-hwp/security/advisories/new
If unavailable, contact a maintainer privately before disclosing details.

Known limits include rendering differences from Hancom, unsupported document features,
and upstream dependency advisories. Save verification does not certify pixel identity
with Hancom. Keep backups and review important exports in the intended application.
