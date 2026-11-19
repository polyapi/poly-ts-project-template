# Agents

This folder is reserved for local agent instructions and skills.

The template does not vendor skills by default. Install the skills for your
project from the PolyAPI skills repository with Flow:

```bash
pnpm flow skills add
pnpm flow skills update
```

<https://github.com/polyapi/poly-skills>

Flow records the selected setup in `flow-skills.json`. Commit it with
`skills/`.

Keep installed skills small and project-relevant. If a skill conflicts with
checked-in code or artefacts, follow the checked-in implementation and update
the stale guidance.
