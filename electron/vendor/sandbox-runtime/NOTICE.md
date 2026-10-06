# Sandbox Runtime subset

Source: https://github.com/anthropics/sandbox-runtime
Release: @anthropic-ai/sandbox-runtime 0.0.78 (Apache-2.0).

These nine files are copied byte-for-byte from the published package. Their SHA-256 values are in provenance.json. Meihua imports only the macOS Seatbelt policy generator and its local dependencies. TLS interception, MITM certificate generation, SOCKS proxies, Linux/Windows binaries and node-forge are not included.

This subset is pinned. Upstream changes must be reviewed and revalidated against filesystem/network/process probes before updating it. No security policy code has been rewritten here. Java and seccomp helpers are retained only because upstream imports them; Meihua does not enable those execution paths.
