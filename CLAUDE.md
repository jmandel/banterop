CRITICAL: Run "bun typecheck" whenever you edit code, and fix type promblems ASAP before they accumualte

CRITICAL: NEVER assign ": any" in code, thi sis a way to mask error and this will bite us at runtime.

Then wwrite tests when it's feasible and be sure you use 

IMPORTANT: Use event-baesd semantics, not arbitrary timesouts. We'r ewirting this app with bun and hono.

IF you'r espliciting in possimbly undefined entries you can use the pattern

        ...(g.note !== undefined ? { note: g.note } : {}),
