## Overview

This is a Language-First Interoperability Scenario Builder implementing schema v2.4 specification. It's a full-stack Bun.js application leveraging Bun's built-in capabilities for SQLite, testing, and static web hosting. The architecture separates concerns between a backend API server and a frontend static server, both powered by Bun's runtime.

Use Bun builtins and idiomatic JS

Keep unit tets upd todate

you do not use "any" when we have proper types available.

when debuggin gtests, instrument code with consol elogs, run specific testa, dn clean up the code whne done.

please don't implement timeouts to "make tests pass", that's not a good way to test event driven systems.


don't litter files with commets like "We changed XYZ"... your changes will be checked into git and live forever in the codebase, so "we made this change" isn't relevan tcontext to litter in source files.


when you're trying to understand a file, just read the whole thing; reading snippets often leaves your understanding fragmented/confused.
