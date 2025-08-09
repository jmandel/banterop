run bun typecheck when makign changes (dont' redirect sterr, just runthe command)

this is a bun projec ttargeting greenfield eployment; we'r enot worried about backwrds compatibiltiy or legacy usage.
 We want to fail loundly when thing go wrong s oavoid "clever" fallbacks and implicit behaviors unless they're specifically requesed.
