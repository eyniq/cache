# Security policy

## Supported versions

Security fixes are released for the latest minor version of Eyniq Cache. Please upgrade to the latest release before reporting a problem you found in an older one.

| Version        | Supported |
| -------------- | --------- |
| latest release | yes       |
| older releases | no        |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub private vulnerability reporting: open the [Security tab](https://github.com/eyniq/cache/security) of this repository and choose "Report a vulnerability". Include the affected version, a description of the impact and, if you can, steps to reproduce. If you cannot use GitHub, e-mail developer@eyniq.com instead.

You can expect an acknowledgement within a few working days. We will keep you informed while we investigate, agree a disclosure date with you, and credit you in the release notes if you wish.

## Scope

In scope: the cache server (HTTP routes, authentication and authorization, the minimum release age policy, storage backends), the container image and the Helm chart.

Out of scope: vulnerabilities in the upstream registry or in third-party packages that are only proxied by the cache, and findings that need an already-compromised storage backend (stored data is trusted when read, see `docs/OPERATIONS.md`).
