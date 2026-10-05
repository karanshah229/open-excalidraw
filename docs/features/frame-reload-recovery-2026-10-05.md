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
- Subsequent Java 26 release run: all 19 older browser suites passed; the permission
  contract failed immediately after the same RTDB emulator exception returned
  `INTERNAL [500]`. This is an observed emulator failure, not proof of its cause.
- Java 21 was installed and selected only for a comparison test process; the
  machine's default Java selection was not changed.
- Final full comparison run under Java 21: **13/13 stages passed**, including all
  **19 older browser suites** and **five behavior scenarios**. Assertions and
  timeouts were unchanged. No RTDB namespace crash occurred in this run. This does
  not establish that Java 26 caused the earlier emulator crash.

The successful invocation selected Java only for the test process:

```sh
env JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH caffeinate -i npm test
```

The executable application fix is commit `395ecba`, based on merged main
`d91fd63`. The later report/audit changes do not change the deployed application.

Development verification: all three deployed rule sets match the repository,
all 148 client chunks match the staged build, and authenticated PNG insertion,
reload and movement succeeded. Backend reads confirmed position changes with
unchanged Storage object generations and no download tokens. Development's ten
main Functions were replaced; eight unrelated freemium HTTP endpoints were
retained and are not called by the merged client.

Production verification: all ten main Functions are active in the configured
regions, and all three rule sets and 148 client chunks match the staged release.
Seven legacy shared boards were linked to their parent projects; access mirrors
have zero missing or mismatched records. App Check remains enforced in production.
Authenticated board creation, PNG insertion, reload and movement succeeded.
Movement changed the saved position without changing the Storage generation;
the asset contains no public download token or inline bytes in its board record.
A native frame containing the image also survived a fresh production reload,
with two elements and `All changes saved` visible.
An unsigned request to the production test image URL was denied with HTTP 401.

The deployment audit's static image-transport flag previously required an obsolete
error-message literal removed by the shared callable module. It now checks the
`boardAsset` reference. This flag is a bundle heuristic, not an end-to-end test;
the separate signed-in Chrome checks above verify the actual behavior.

Both environments are live with merged main plus the frame repair. PR #4 tracks
the unmerged repair and validation record; it was not merged as part of deployment.

Detailed logs and screenshots are local artifacts under `.system_generated`;
private diagrams and account details are not committed.
