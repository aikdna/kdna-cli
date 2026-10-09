# Historical CLI tests before native-section migration

The two JavaScript files here preserve the exact pre-migration tests. They refer to the older container 0.2, Core/IR component and Read 0.2 fixture graph and original relative paths; they are historical source, not executable tests of the current native-section package. Their fixtures and oracle files remain under `tests/fixtures/` unchanged.

Current tests create native 0.6 assets from disclosed authored input and verify supported component bodies, exact diagnostics, local consent, byte budget, all four Read modes and same-session handles. Legacy fixture rejection is checked against the current Core admission result. Historical success is not claimed for an unsupported tuple.
