# Security policy

Melarc is proprietary software under development. It has no released version yet, so there is no list of supported
versions: a report is read against the current `main` branch.

## Reporting a vulnerability

Email the details to **melarclogistics@gmail.com**. Please do not open a public issue or pull request for a
vulnerability.

A useful report says what you found and where, how to reproduce it, and what it lets an attacker do. Do not put a real
credential, token or personal data in the report: say where it can be found instead.

While looking for a vulnerability, do not access, change or delete data that is not yours, and do not disrupt a running
service.

## How the platform is secured

The design, and the checks that hold it, are in [architecture/SECURITY_DESIGN.md](architecture/SECURITY_DESIGN.md) and
the [security test matrix](standards/security-test-matrix.md).
