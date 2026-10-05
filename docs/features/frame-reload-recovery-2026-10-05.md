# Persisted frame reload recovery

Reloading a saved scene containing a frame could hide the entire diagram and display
`Local save failed`. Loading used `convertToExcalidrawElements`, a generation API
whose frame skeletons require `children`. Native saved frames use `frameId` on
their members and do not have that field, so conversion threw on `children.forEach`.

The editor now loads persisted elements with Excalidraw's `restoreElements`.
Generation still uses the skeleton converter. Load failures also log their actual
error so a rendering failure can be diagnosed without guessing at storage state.
This repair requires no board data migration.

The `framed-scene-reload` browser contract saves a native frame with a bound label
and a deleted member, then opens the real editor and verifies IDs, membership,
versions, deletion flags and bindings. It failed before the repair and passed
afterward. Empty binding lists compare null/absent and `[]` equivalently because
restoration canonicalizes them; actual binding relationships remain asserted.

Logged-in Chrome verification recovered the reported local diagram on a fresh
reload, with 178 elements and the status `All changes saved`.

## Validation record

- Initial full run: 12/13 stages; one reconnect assertion failed. Four isolated
  reconnect probes passed without changing its assertions. The cause of that
  initial intermittent failure remains unconfirmed.
- Next full run: RTDB emulator logged a Scala `NullPointerException`, cleared
  namespace connections and produced cascading failures. Logs were preserved.
- Fresh full run: all 19 older browser suites passed; the behavior suite passed
  reload and permission checks but timed out during the pending-close scenario.
- Isolated behavior rerun: all five scenarios passed, including both pending-close
  scenarios. No assertion or timeout was relaxed.
- Final release run and deployment verification: pending; update before release.

Detailed logs and screenshots are local artifacts under `.system_generated`;
private diagrams and account details are not committed.
