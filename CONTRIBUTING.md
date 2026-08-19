# Contributing to Angel

First off, thank you for considering contributing to Angel! It's people like you that make Angel such a great tool.

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/) to maintain a readable project history. Please use the following prefixes for your commit messages:

- `feat:` A new feature
- `fix:` A bug fix
- `docs:` Documentation only changes
- `style:` Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)
- `refactor:` A code change that neither fixes a bug nor adds a feature
- `perf:` A code change that improves performance
- `test:` Adding missing tests or correcting existing tests
- `chore:` Changes to the build process or auxiliary tools and libraries such as documentation generation

**Example:**
`feat: add LLM decision cache mechanism`

## Branching Strategy
1. Create a new branch from `main` (e.g. `feat/new-strategy` or `fix/tp-bug`)
2. Commit your changes using the guidelines above.
3. Open a Pull Request against the `main` branch.

## Getting Started
Please read the README.md for setup instructions. Ensure you have Node.js 20+ and the required build tools for `better-sqlite3` and `canvas`.
