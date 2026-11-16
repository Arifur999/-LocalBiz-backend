#!/usr/bin/env bash
# Cross-tenant regression check, LOCAL ONLY.
#
# Makes two E2E owners, gives each an account, and has owner A try to point its
# own transfer at owner B's account. Must answer 404 and leave the row alone;
# before the 2026-11-16 audit fix it answered 200 and moved the money.
#
# Needs: the dev server on :5100 with LOGIN_OTP_ENABLED=false, and the
# localbiz-postgres container. Deletes everything it created on the way out.
set -u
API=${API:-http://localhost:5100/api/v1}
DB_CONTAINER=${DB_CONTAINER:-localbiz-postgres}
PW='E2e-Test-Pass1!'
JAR_A=$(mktemp); JAR_B=$(mktemp)

sql() { docker exec -i "$DB_CONTAINER" psql -U localbiz -d localbiz -tAc "$1"; }
cleanup() {
  local owners="select id from users where email like 'e2e-%@localbiz.test'"
  sql "delete from account_transfers where owner_id in ($owners)" >/dev/null
  sql "delete from accounts where owner_id in ($owners)" >/dev/null
  sql "delete from admin_activities where owner_id in ($owners)" >/dev/null
  sql "delete from users where email like 'e2e-%@localbiz.test'" >/dev/null
  rm -f "$JAR_A" "$JAR_B"
}
trap cleanup EXIT
cleanup

json_id() { node -pe "JSON.parse(require('fs').readFileSync(0)).data?.id ?? ''"; }

for who in a b; do
  curl -s -o /dev/null -X POST "$API/auth/register" -H 'Content-Type: application/json' \
    -d "{\"fullName\":\"E2E Owner $who\",\"businessName\":\"E2E Shop $who\",\"phone\":\"0170000000$who\",\"email\":\"e2e-$who@localbiz.test\",\"password\":\"$PW\"}"
done
sql "update users set email_verified=true where email like 'e2e-%@localbiz.test'" >/dev/null
sql "update owner_subscriptions set status='active', plan_status='active', expiry_date=now()+interval '30 days'
     where owner_id in (select id from users where email like 'e2e-%@localbiz.test')" >/dev/null

login() { curl -s -c "$1" -o /dev/null -w "%{http_code}" -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$2\",\"password\":\"$PW\"}"; }
[ "$(login "$JAR_A" e2e-a@localbiz.test)" = 200 ] && [ "$(login "$JAR_B" e2e-b@localbiz.test)" = 200 ] || { echo "FAIL: E2E login"; exit 1; }

account() { curl -s -b "$1" -X POST "$API/accounts" -H 'Content-Type: application/json' -d "{\"name\":\"$2\",\"type\":\"cash\"}" | json_id; }
A1=$(account "$JAR_A" "E2E A cash"); A2=$(account "$JAR_A" "E2E A bank"); B1=$(account "$JAR_B" "E2E B cash")

T=$(curl -s -b "$JAR_A" -X POST "$API/account-transfers" -H 'Content-Type: application/json' \
  -d "{\"from_account_id\":\"$A1\",\"to_account_id\":\"$A2\",\"from_account_name\":\"E2E A cash\",\"to_account_name\":\"E2E A bank\",\"amount\":100,\"date\":\"2026-11-16\"}" | json_id)
[ -n "$T" ] || { echo "FAIL: could not create the E2E transfer"; exit 1; }

code=$(curl -s -b "$JAR_A" -o /dev/null -w "%{http_code}" -X PATCH "$API/account-transfers/$T" \
  -H 'Content-Type: application/json' -d "{\"to_account_id\":\"$B1\"}")
stored=$(sql "select to_account_id from account_transfers where id='$T'")

if [ "$code" = 404 ] && [ "$stored" = "$A2" ]; then
  echo "PASS: owner A cannot point a transfer at owner B's account (HTTP $code)"
else
  echo "FAIL: cross-tenant PATCH answered $code; to_account_id is now $stored"
  exit 1
fi
