# End-to-end UI test in headless Chromium against the in-memory Firebase stand-in.
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', 'tests/www'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
OFFICE = (25.285400, 51.531000)
def near(m_north):  # point m metres north of office
    return {'latitude': OFFICE[0] + m_north / 111320, 'longitude': OFFICE[1], 'accuracy': 8}
errors = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: errors.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, geolocation=near(40), permissions=['geolocation'])
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('JS error: ' + str(e)))
    pg.goto('http://localhost:8765/')
    pg.wait_for_selector('#s-login:not(.hidden)')
    check(pg.is_visible('#setup-btn'), 'first-time setup offered on a fresh project')
    pg.screenshot(path=f'{OUT}/01-login.png')

    # First admin
    pg.click('#setup-btn')
    pg.fill('#su-name', 'Ahmed Admin'); pg.fill('#su-user', 'Admin'); pg.fill('#su-pass', 'secret1')
    pg.click('#setup-form button[type=submit]')
    pg.wait_for_selector('#s-main:not(.hidden)')
    check(pg.is_visible('#tab-admin'), 'admin tab shown for admin')
    time.sleep(0.5)
    check('locked' in pg.get_attribute('#punch-btn', 'class'), 'punch locked until office is set')
    pg.screenshot(path=f'{OUT}/02-no-office.png')

    # Office zone
    pg.click('[data-tab=admin]'); pg.click('[data-sub=office]')
    pg.click('#o-here'); pg.wait_for_function("document.getElementById('o-lat') && document.getElementById('o-lat').value !== ''")
    pg.fill('#o-lat', str(OFFICE[0])); pg.fill('#o-lng', str(OFFICE[1]))
    pg.click('#o-save'); time.sleep(0.4)
    office = pg.evaluate("window.__store.get('config/office')")
    check(office and office['radius'] == 100 and abs(office['k'] - 0.9042) < 0.01, 'office saved with 100 m radius and cos factor')
    pg.screenshot(path=f'{OUT}/03-office.png', full_page=True)

    # Add employee
    pg.click('[data-sub=staff]'); pg.click('#add-emp')
    pg.fill('#mf-0', 'Rashid Khan'); pg.fill('#mf-1', 'FX-014'); pg.fill('#mf-2', 'Technician'); pg.fill('#mf-3', 'pass123')
    pg.click('#modal-ok'); time.sleep(0.5)
    st = pg.evaluate("window.__store.get('staff/fx-014')")
    check(st and st['role'] == 'staff' and st['device'] is None, 'employee created with no phone yet')
    pg.screenshot(path=f'{OUT}/04-staff.png', full_page=True)

    # Employee signs in on phone A
    pg.click('[data-tab=profile]'); pg.click('#logout'); pg.click('#modal-ok')
    pg.wait_for_selector('#s-login:not(.hidden)')
    check(not pg.is_visible('#setup-btn'), 'setup button hidden after setup is done')
    pg.fill('#login-user', 'fx-014'); pg.fill('#login-pass', 'pass123'); pg.click('#login-form button[type=submit]')
    pg.wait_for_selector('#s-main:not(.hidden)'); time.sleep(1.2)
    check(not pg.is_visible('#tab-admin'), 'no admin tab for employee')
    check(pg.evaluate("window.__store.get('staff/fx-014').device") is not None, 'phone registered on first sign-in')
    check('Inside office zone' in pg.inner_text('#zone-card'), 'inside zone at 40 m')
    pg.screenshot(path=f'{OUT}/05-home-inside.png')
    pg.click('#punch-btn'); time.sleep(1.5)
    keys = pg.evaluate("[...window.__store.keys()].filter(k=>k.startsWith('punches/'))")
    first = keys[0] if keys else ''
    check(len(keys) == 1 and first.startswith('punches/fx-014_'), f'one punch saved ({first})')
    pdoc = pg.evaluate(f"window.__store.get('{first}')") if first else {}
    check(pdoc.get('dist', 999) <= 45 and pdoc.get('manual') is False, 'punch stores distance and is not manual')
    pg.screenshot(path=f'{OUT}/06-after-first-punch.png')

    # Walk away 230 m
    ctx.set_geolocation(near(230)); pg.click('#refresh-btn'); time.sleep(1.5)
    check('locked' in pg.get_attribute('#punch-btn', 'class'), 'button locked outside zone')
    check(pg.is_visible('#exc-btn'), 'exception request offered outside zone')
    pg.screenshot(path=f'{OUT}/07-outside.png')
    pg.click('#exc-btn'); pg.fill('#mf-0', 'Treadmill repair at customer gym'); pg.click('#modal-ok'); time.sleep(0.5)
    reqs = pg.evaluate("[...window.__store.entries()].filter(([k])=>k.startsWith('requests/')).map(([,v])=>v)")
    check(len(reqs) == 1 and reqs[0]['slot'] == 'amOut' and reqs[0]['dist'] > 200, 'exception request sent for AM out with distance')

    # History
    pg.click('[data-tab=history]'); time.sleep(0.6)
    pg.screenshot(path=f'{OUT}/08-history.png')
    check('Days present' in pg.inner_text('#h-stats'), 'history stats shown')

    # Same account on another phone → locked
    ctx2 = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, geolocation=near(10), permissions=['geolocation'])
    pg2 = ctx2.new_page()
    pg2.on('pageerror', lambda e: errors.append('JS error (phone B): ' + str(e)))
    pg2.goto('http://localhost:8765/')
    # share the fake backend: copy store + users into the second page
    state = pg.evaluate("JSON.stringify({s:[...window.__store.entries()],u:[...window.__users.entries()]})")
    pg2.wait_for_selector('#s-login:not(.hidden)')
    pg2.evaluate("(st)=>{const o=JSON.parse(st);o.s.forEach(([k,v])=>{for(const f in v){if(v[f]&&v[f]._ms!==undefined){const ms=v[f]._ms;v[f]={_ms:ms,toMillis(){return ms}}}}window.__store.set(k,v)});o.u.forEach(([k,v])=>window.__users.set(k,v))}", state)
    pg2.fill('#login-user', 'fx-014'); pg2.fill('#login-pass', 'pass123'); pg2.click('#login-form button[type=submit]')
    pg2.wait_for_selector('#s-main:not(.hidden)'); time.sleep(1.2)
    check('locked' in pg2.get_attribute('#punch-btn', 'class') and 'another phone' in pg2.inner_text('#punch-hint'), 'second phone is locked')
    pg2.screenshot(path=f'{OUT}/09-other-phone.png')
    ctx2.close()

    # Admin approves the request
    pg.click('[data-tab=profile]'); pg.click('#logout'); pg.click('#modal-ok')
    pg.wait_for_selector('#s-login:not(.hidden)')
    pg.fill('#login-user', 'admin'); pg.fill('#login-pass', 'secret1'); pg.click('#login-form button[type=submit]')
    pg.wait_for_selector('#s-main:not(.hidden)'); time.sleep(1)
    check(pg.inner_text('#admin-dot').strip() == '1', 'admin sees 1 pending request badge')
    pg.click('[data-tab=admin]'); pg.click('[data-sub=req]'); time.sleep(0.3)
    pg.screenshot(path=f'{OUT}/10-requests.png')
    pg.click('[data-ok]'); time.sleep(0.6)
    keys = pg.evaluate("[...window.__store.keys()].filter(k=>k.startsWith('punches/fx-014'))")
    check(any(k.endswith('_amOut') for k in keys), 'approved request became an AM out punch')
    pg.click('[data-sub=live]'); time.sleep(0.4)
    pg.screenshot(path=f'{OUT}/11-live.png', full_page=True)
    check('Rashid Khan' in pg.inner_text('#a-live'), 'live board lists employee')

    # Report + export
    pg.click('[data-sub=report]'); time.sleep(0.6)
    pg.screenshot(path=f'{OUT}/12-report.png')
    with pg.expect_download() as dl:
        pg.click('#r-export')
    path = dl.value.path(); csv = open(path, encoding='utf-8-sig').read()
    check(csv.startswith('Date,Day,Employee ID') and 'FX-014' in csv and 'Rashid Khan' in csv, 'CSV export has the employee row')
    print(csv)

    # Password reset → old password stops working
    pg.click('[data-sub=staff]'); time.sleep(0.3)
    pg.click('[data-act=pass][data-id=fx-014]'); pg.fill('#mf-0', 'newpass9'); pg.click('#modal-ok'); time.sleep(0.6)
    pg.click('[data-tab=profile]'); pg.click('#logout'); pg.click('#modal-ok')
    pg.wait_for_selector('#s-login:not(.hidden)')
    pg.fill('#login-user', 'fx-014'); pg.fill('#login-pass', 'pass123'); pg.click('#login-form button[type=submit]'); time.sleep(1)
    check(pg.is_visible('#s-login') and pg.inner_text('#login-err') != '', 'old password rejected after reset: ' + pg.inner_text('#login-err'))
    pg.fill('#login-pass', 'newpass9'); pg.click('#login-form button[type=submit]')
    pg.wait_for_selector('#s-main:not(.hidden)'); time.sleep(1)
    check(pg.is_visible('#punch-btn'), 'new password works and history kept')
    b.close()
srv.terminate()
print('\nERRORS:' if errors else '\nALL PASSED', *errors, sep='\n')
