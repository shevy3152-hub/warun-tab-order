# Seasonal customer display QA application

The `qa` Android build type produces a separate, debug-signed application named
**Warun Kiosk QA**, with application ID `jp.co.warun.androidkiosk.qa`.
The existing `debug` and `release` IDs remain `jp.co.warun.androidkiosk`.
Each application has its own Android preferences and WebView storage.

## Entry and navigation

- Standard application: `http://192.168.11.6:25173/customer/customer-01`.
- QA application: `http://192.168.11.6:60291/qa-a90-kiosk-start.html`.
- QA customer page: `http://192.168.11.6:60291/customer/customer-01`.

The QA URL policy permits only the two QA navigation paths on that exact HTTP
origin, rejects user information/query/fragment, and never accepts pairing URLs.
Standard pairing and navigation policy is unchanged. QA manifest VIEW handling
also uses its own origin and entry path. Recovery returns to the entry for the
current variant.

The QA start page belongs to the dedicated temporary QA bundle, not this APK.
The entry reads the existing QA customer registration from IndexedDB with a
readonly transaction. It checks the saved credential and device assignment via
the dedicated QA server, then uses location.replace in the same WebView.
Missing, different or invalid registration stops without overwrite. No admin
input, credential issuance, registration write or credential embedding is used.
## Display measurement

Both variants use the same landscape manifest setting and native immersive
implementation. The QA sampler reads only the rendered customer root's CSS
viewport, DPR, image dimensions and landscape/fullscreen indicators. It adds
native orientation, immersive/fullscreen/navigation flags and, on Android 30+,
actual status/navigation bar visibility.

Safe records appear under the `WarunKioskQA` Android log tag and are sent to
`/qa-a90-metrics` in the dedicated QA server. The server stores native records in
`a90-kiosk-viewport.ndjson`. There is no JavaScript-to-OS bridge, debug overlay,
credential/text collection, order submission or browser Fullscreen API request.
The original QA application reached the real customer UI on A90 through
2026-10-12 and again after the dedicated QA restart on 2026-10-13. These results
apply to the installed original APK, which includes the pending recovery trials.
Acceptance is recorded per check below; seasonal-image acceptance as a whole
is not marked PASS.

## Acceptance status (2026-10-13)

| Check | Result and scope |
|---|---|
| Original QA APK: real customer arrival through 2026-10-12 | PASS, previously confirmed. |
| Original QA APK: real customer arrival after QA restart on 2026-10-13 | PASS, isolation QA/table 99 screen and customer/customer-01 page-finished/visible-commit logs confirmed before this replacement attempt. |
| Candidate APK excluding the process override and delayed WebView creation | PASS on 2026-10-13 after the separately authorized QA-only force-stop and install -r; existing registration reached isolation QA/table 99 and customer/customer-01. |
| User-confirmed display-condition, zoom/X-Y and theme switching | PASS for preview/generated-prompt tracking; existing user confirmation was retained without rerunning it. |
| User-confirmed X operation | PASS; existing user confirmation retained. |
| Seasonal-image QA at 1280x800 / 1637x602 CSS px, DPR1 | NOT VERIFIED. |
| Improvement of Y movement range | DEFERRED. |

The completed user checks do not establish safety across all themes, zoom ranges,
Y movement ranges or unverified display conditions.

### Candidate device verification attempt (2026-10-13)

The separately built candidate retains QA package jp.co.warun.androidkiosk.qa,
URL restrictions, measurement, bounded diagnostics and the explicit STOP action.
Its manifest has no application/activity process override, so its default process
is jp.co.warun.androidkiosk.qa. It excludes the four related delayed-creation
changes in MainActivity and does not include app/src/qa/AndroidManifest.xml.
Candidate APK SHA-256:
EB20FD502B36C583E88BE28F9052409F2E8B9D611CE61A4DAAC480419BBA42AE.

The temporary launcher's process detection was changed only to check both
jp.co.warun.androidkiosk.qa and jp.co.warun.androidkiosk.qa:qa_display. Its previous
script was retained under a separate name. The stored original APK matched the
installed APK byte-for-byte and was copied as rollback-installed-qa-20261013.apk
beside the candidate verification project; no device APK extraction was needed.
Rollback APK SHA-256:
6F7640B268366C0797DEB096254BA0B612088BB6C31D8A8271573B2AB808372F.

The explicit QA component received STOP once with Status: ok. The one subsequent
PID check still returned 16044 for jp.co.warun.androidkiosk.qa:qa_display.
ActivityManager classified it as cached=true, empty=true, curProcState=19.
Normal activity exit is distinguished from process termination: the required
no-PID condition was not confirmed. No repeat STOP, force-stop, candidate install,
registration, data clearing or further launch was performed. The dedicated PC QA
server was kept running. At that stopping point, candidate device arrival had not been verified; the separately authorized continuation is recorded below.
The recorded PID is historical evidence, not an identifier for a future stop.

### Authorized QA-only force-stop and candidate arrival (2026-10-13)

After the cached/empty-process stopping point, the user explicitly authorized
one force-stop of jp.co.warun.androidkiosk.qa only. The one following PID check
found neither jp.co.warun.androidkiosk.qa nor its former :qa_display process.
The already generated candidate APK was then installed with adb install -r:
Performing Streamed Install / Success. No uninstall or data clearing was used.

The explicit QA activity component was opened once without restarting the PC
server. Candidate default process jp.co.warun.androidkiosk.qa (PID 16679 at this
check) became foreground. The captured screen showed isolation QA and table 99.
Its bounded QA diagnostic log recorded customer/customer-01 page_commit_visible
at 18:07:48.245 JST and page_finished at 18:07:48.268 JST. Existing registration
and authentication were reused without input or issuance. Candidate real-customer
arrival is PASS for this single launch with both pending recovery trials excluded.
No image acceptance, all-theme/range acceptance, failure recovery or reboot
persistence is inferred from this arrival result.

Evidence is retained in the separate candidate verification directory as
candidate-a90-arrival-20261013.log and candidate-a90-arrival-20261013.png.
The rollback APK, generated candidate APK and original recovery-trial source
remain retained. No new build, tests, order/call/payment operation or Git staging,
commit or push was performed. The candidate QA activity and the existing dedicated
PC QA server were left running; the server was not restarted.

## QA display recovery diagnostics

The original worktree retains the QA-only `:qa_display` process override and
creation of the first WebView after window focus as recovery trials whose
necessity remains undetermined. These changes stay in the worktree and are
excluded from the separately built commit candidate. The four delayed-creation
changes must be excluded together to retain the existing WebView creation and
URL-loading order. The source trials and the installed original APK are distinct
from the candidate APK. The standard variants have no process-name override.

On A90, the former QA process could retrieve the entry and health with native HTTP
200, while Android refused its WebView child-service startup with `process is bad`.
The earlier process override restored page-start, page-finish and visible-commit
events once, but child-service refusal recurred after the dedicated restart check.
Process renaming is not a confirmed durable fix. Normal QA exit and relaunch also
failed to restore rendering. DuraSpeed was suppressing the QA package. Adding it
to the platform whitelist alone did not release existing suppression; applying
the app whitelist with all existing entries plus the QA package restored rendering.
That QA-package-only device setting was explicitly approved by the user.
No whole-device reset, provider change, data clearing or further blind retries were used.

The QA-only explicit `jp.co.warun.androidkiosk.qa.action.STOP` action releases the
WebView and finishes its task. It requires the explicit QA activity component,
is ignored by standard variants, and does not clear application data.

The temporary entry now reads the existing customer credential from IndexedDB
in a readonly transaction, verifies it against the QA registration-match endpoint
and current configuration, and navigates in the same WebView. It has no admin
input or registration write. Missing, different or invalid registration stops.
Its four targeted logic checks passed. After the DuraSpeed fix, one dedicated
server stop/restart returned A90 to the real customer UI without admin input.
The launcher checks the QA app whitelist entry and only adds it if missing,
preserving all existing entries. Device reboot persistence is unverified.
The existing temporary `start-qa.ps1` is the single lifecycle implementation;
CMD shortcuts and the former restart script delegate to it. DB/bundle identity,
health, LAN and saved authentication checks are sufficient for server readiness,
but are not evidence of WebView rendering success.

`WarunKioskQADiag` logs only bounded event labels, main/subresource classification,
numeric error/status fields and navigation-policy decisions. URL labels omit
user information, query and fragment; arbitrary origins and paths are replaced
with coarse labels. Console messages, headers, response bodies and credentials
are not logged. QA native probes only GET the fixed health and entry URLs.
The candidate retains the existing renderer recovery limits and watchdog code. Existing-registration customer arrival was verified once; renderer failure recovery and device reboot behavior remain unverified.

The temporary QA entry page now checks image layout against the dedicated QA
settings endpoint instead of the former hardcoded contain/center values. Its
existing-registration conflict guard and saved server authentication remain in place.

## Build and verification

With the existing Android SDK and compatible JDK, run from `android-kiosk`:

```text
gradlew.bat --offline --no-daemon :app:pairingPolicyTest :app:qaUrlPolicyTest :app:pinSecurityTest :app:testDebugUnitTest :app:testQaUnitTest :app:lintQa :app:assembleQa
```

The APK is `app/build/outputs/apk/qa/app-qa.apk`. The QA build type uses the standard
Android debug signing configuration; existing release signing is unchanged.
APK creation does not install, uninstall, clear data, change defaults or launch
either application on A90.
