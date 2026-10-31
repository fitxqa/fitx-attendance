# FitX Attendance — staff check-in / check-out with a GPS office zone

Attendance app for FitX Sports Equipment Services staff, set up for a **straight shift**: technicians punch **four times
a day** on their own phone — **morning check-in** (09:00), **leave for site visits** (~10:00), **back from visits** (~22:00)
and **night check-out** — and a punch only works **within 100 m of the office** (the admin can change the radius and the
times). Duty hours run from morning check-in to night check-out. The working day ends at 04:00, so a return after
midnight still counts for the same day. Runs on the **free Firebase Spark plan** (no billing, no card).

This is a **completely separate project** from FitX Call: its own Firebase project, its own app ID
(`qa.fitx.attendance`), its own logins and its own signing key.

## What it does

**Employees**
- Sign in with **Employee ID + password** (given by the admin). The account is tied to **one phone**.
- Live radar shows the distance to the office; the big orange button punches the next slot.
- Outside the zone the button locks. Working at a customer's gym? **Request an exception** — the admin approves it.
- **History**: every day's four punches for any month, hours worked, late / early-out count.

**Admin** (Admin tab)
- **Today**: who is in the office, on break, late or not punched; distance at each punch; **Fix punch** for mistakes.
- **Requests**: approve / reject exception requests (with a map link to where the person was).
- **Employees**: add, change password, reset phone, edit, make admin, disable (history is kept).
- **Office zone**: set the office point (“Use my current location”), radius, the two shift times and the grace period.
- **Monthly report**: days, hours, late and missed check-outs per employee, and **Export Excel** (CSV, opens in Excel).
- **Payroll**: monthly salary per employee; overtime beyond 12 duty hours (× 1.25), late deduction (per late minute at the hourly rate, or a fixed amount), QR 100 per absent work day, excused days, bonus / other deductions, **Export Excel**. Salaries are visible to admins only.

## How cheating is blocked
Every punch is re-checked by the database rules (`firestore.rules`), not just by the app:
- the time is the **server's time** (changing the phone's clock does nothing) and the date must be **today in Qatar**;
- the position must be **inside the office circle**, and punches must come **in order**, once each per day;
- the punch must come from the employee's **registered phone**;
- the app refuses to punch when a **fake-GPS app** is active, or when the GPS signal is weak (worse than ±80 m).

## Setup (one time, free)

1. **Create the Firebase project** — [console.firebase.google.com](https://console.firebase.google.com) → *Create a
   project* → name it `FitX Attendance` (Analytics off). It stays on the free Spark plan.
2. **Run the setup** in [Google Cloud Shell](https://shell.cloud.google.com) (signed in with the same Google account):
   ```
   bash <(curl -fsSL https://raw.githubusercontent.com/fitxqa/fitx-attendance/main/setup.sh)
   ```
   Enter the new project's ID. It creates the database, switches on sign-in, publishes the security rules and prints
   one line of app settings. (It refuses to run on the FitX Call project.)
3. **Add two GitHub secrets** — repo → *Settings → Secrets and variables → Actions → New repository secret*:
   - `FITX_ATT_FIREBASE` = the line printed by the setup script
   - `FITX_ATT_KEY` = the long line from **FitX-Attendance-Secret.txt** (the app's signing key — keep a backup!)
4. **Build** — *Actions → Build APK → Run workflow* (it also runs on every push). Install **FitX-Attendance.apk**
   from **[Releases](https://github.com/fitxqa/fitx-attendance/releases/latest)**.
5. **First admin** — open the app → *First-time setup (create admin)*. Then *Admin → Office zone*: stand in the office,
   tap *Use my current location*, *Save zone*. Then *Admin → Employees → Add employee*.

## Files
| Path | What |
|---|---|
| `src/app.js` | All screens: login, punch, history, profile, admin |
| `src/geo.js`, `src/time.js` | GPS / distance, Qatar time helpers |
| `www/` | HTML, styles, fonts, Firebase settings (written by the build) |
| `firestore.rules` | Security rules (published by `setup.sh`) |
| `android/app/src/main/java/qa/fitx/attendance/GuardPlugin.java` | Fake-GPS check |
| `.github/workflows/build-apk.yml` | Builds the signed APK on every push |
| `tests/` | Browser test of the full flow against an in-memory database (`node tests/build-test.mjs && python3 tests/ui_test.py out/`) |
| `tools/make-icons.mjs` | Regenerates the launcher icon and splash from the FitX logo |

## Data (Firestore)
| Collection | Holds |
|---|---|
| `staff/{employeeId}` | name, title, role (admin/staff), current login, registered phone, disabled |
| `punches/{employeeId}_{yyyymmdd}_{slot}` | one punch: server time, position, distance, phone, manual flag |
| `requests/{id}` | exception requests and the admin's decision |
| `config/office` | office point, radius, shift times, grace minutes |
| `logins`, `accounts`, `clock`, `config/setup` | sign-in plumbing |

Notes: an employee who reinstalls the app or changes phone needs **Reset phone** from the admin. On the free plan an
admin can't change someone's password directly, so *Password* gives them a fresh login (their history is kept).
