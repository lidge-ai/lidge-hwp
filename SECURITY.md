# Security

종이(Jongi) is a local, single-user document workbench. The HTTP server binds to `127.0.0.1`.
Do not expose it through a public reverse proxy, shared-host tunnel, or remote bind.
It does not provide multi-user authentication.

Google import (`/api/office/import-url`) only accepts `docs.google.com` share links and
fetches the corresponding Google export endpoints. It follows redirects but checks the
final response host against a Google allowlist (`docs.google.com`, `*.google.com`,
`*.googleusercontent.com`) and rejects anything else, so it cannot be used as an
open proxy. Downloads are capped at 64 MB and only office bytes that pass format
sniffing are stored.

LibreOffice (`soffice`) conversions run locally as child processes with a fresh
per-call user profile directory (`-env:UserInstallation` under a temporary folder)
that is removed after each conversion. LibreOffice is not bundled; only the locally
discovered binary is executed.

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
