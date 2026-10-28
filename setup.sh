#!/usr/bin/env bash
# FitX Attendance — one-command setup of ITS OWN Firebase project (free Spark plan, no billing).
# It never touches the FitX Call project.
#
# Run in https://shell.cloud.google.com :
#   bash <(curl -fsSL https://raw.githubusercontent.com/fitxqa/fitx-attendance/main/setup.sh)
set -u
REGION=europe-west1
RAW=https://raw.githubusercontent.com/fitxqa/fitx-attendance/main
FITX_CALL_PROJECT=studio-1166518588-1f04b
say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1"; exit 1; }

echo "Firebase console → your NEW FitX Attendance project → Project settings → Project ID"
read -r -p "Project ID of the NEW attendance project: " P
P=$(echo "$P" | tr -d ' ')
[ -z "$P" ] && fail "No project ID given"
[ "$P" = "$FITX_CALL_PROJECT" ] && fail "That is the FitX Call project. Create a NEW project for attendance and use its ID."

gcloud config set project "$P" >/dev/null 2>&1
TOKEN=$(gcloud auth print-access-token 2>/dev/null) || fail "Not signed in. Run:  gcloud auth login   then run this command again."
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "X-Goog-User-Project: $P")
api() { curl -sS "${H[@]}" "$@"; }

say "1/5  Turning on free services (Firestore, Login, Rules)"
gcloud services enable firestore.googleapis.com identitytoolkit.googleapis.com firebaserules.googleapis.com firebase.googleapis.com --project "$P" \
  || fail "Could not turn on services. Is this the Google account that owns the Firebase project?"
ok "Services on"

say "2/5  Database"
if gcloud firestore databases describe --database='(default)' --project "$P" >/dev/null 2>&1; then
  ok "Firestore database already exists"
else
  gcloud firestore databases create --location="$REGION" --project "$P" >/dev/null \
    || fail "Could not create the database. Create it in Firebase console → Firestore Database → Create database ($REGION, Standard), then run this again."
  ok "Firestore database created ($REGION)"
fi

say "3/5  Employee ID + password sign-in"
R=$(api -X PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$P/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}')
if echo "$R" | grep -q '"error"'; then
  echo "Couldn't switch it on automatically. Please do it once by hand:"
  echo "  Firebase console → Authentication → Get started → Email/Password → Enable → Save"
  read -r -p "Press Enter when done… " _
else ok "Sign-in switched on"; fi

say "4/5  Security rules"
RULES=$(curl -fsSL "$RAW/firestore.rules") || fail "Could not download the rules (is the fitx-attendance repo public?)"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"source":{"files":[{"name":"firestore.rules","content":sys.stdin.read()}]}}))' <<<"$RULES")
RS=$(api -X POST "https://firebaserules.googleapis.com/v1/projects/$P/rulesets" -d "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("name") or ("ERR " + json.dumps(d.get("error",d))))')
case "$RS" in ERR*) fail "Rules were rejected: $RS";; esac
REL="projects/$P/releases/cloud.firestore"
R=$(api -X PATCH "https://firebaserules.googleapis.com/v1/$REL" -d "{\"release\":{\"name\":\"$REL\",\"rulesetName\":\"$RS\"}}")
if echo "$R" | grep -q '"error"'; then
  R=$(api -X POST "https://firebaserules.googleapis.com/v1/projects/$P/releases" -d "{\"name\":\"$REL\",\"rulesetName\":\"$RS\"}")
  echo "$R" | grep -q '"error"' && fail "Could not publish rules: $R"
fi
ok "Security rules published"

say "5/5  App settings for the build"
export P TOKEN
CFG=$(python3 - 2>&1 <<'PY'
import json, os, time, urllib.request, urllib.error, sys
P, TOKEN = os.environ["P"], os.environ["TOKEN"]
H = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "X-Goog-User-Project": P}
B = "https://firebase.googleapis.com/v1beta1"
def call(method, url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=H, method=method)
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"error": json.loads(e.read() or b"{}").get("error", {"message": str(e)})}
apps = call("GET", f"{B}/projects/{P}/webApps").get("apps", [])
if apps:
    app_id = apps[0]["appId"]
else:
    op = call("POST", f"{B}/projects/{P}/webApps", {"displayName": "FitX Attendance"})
    if "error" in op: sys.exit("ERR " + json.dumps(op["error"]))
    for _ in range(30):
        o = call("GET", f"{B}/{op['name']}")
        if o.get("done"): break
        time.sleep(2)
    app_id = (o.get("response") or {}).get("appId")
    if not app_id: sys.exit("ERR " + json.dumps(o))
cfg = call("GET", f"{B}/projects/{P}/webApps/{app_id}/config")
if "error" in cfg: sys.exit("ERR " + json.dumps(cfg["error"]))
keep = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"]
print(json.dumps({k: cfg.get(k, "") for k in keep}))
PY
) || fail "Could not read the web app settings: $CFG
Do it by hand: Firebase console → Project settings → Your apps → Web app (</>) → copy the firebaseConfig block."
ok "App settings ready"

printf '\n\033[1;32m=====================================================================\n ALL DONE ✔  (free plan, no billing — FitX Call was not touched)\n=====================================================================\033[0m\n'
echo
echo "Last step — GitHub → fitxqa/fitx-attendance → Settings → Secrets and variables → Actions"
echo "→ New repository secret   Name: FITX_ATT_FIREBASE   Secret: copy this line:"
echo
printf '\033[1;36m%s\033[0m\n' "$CFG"
echo
echo "Then: Actions → Build APK → Run workflow. Install FitX-Attendance.apk from Releases,"
echo "open it and tap “First-time setup (create admin)”."
