#!/usr/bin/env bash
# Sign-in regression checks, LOCAL ONLY (audit follow-up 2026-11-17).
#
#   1. Password reset answers the same for a registered and an unregistered
#      email, at both steps. It used to say "This email is not registered",
#      which let anyone test a list of addresses.
#   2. Signing out ends that session on the server. It used to clear the
#      cookies only, so a copied token kept working for the rest of the session.
#      A second sign-in of the same account must stay signed in.
#
# Needs: the dev server on :5100 with LOGIN_OTP_ENABLED=false, and the
# localbiz-postgres container. Deletes everything it created on the way out.
#
# It calls rate-limited endpoints (2 reset requests, 2 resets, 2 logins,
# 1 sign-up), so running it more than twice in fifteen minutes will trip them.
set -u
API=${API:-http://localhost:5100/api/v1}
DB_CONTAINER=${DB_CONTAINER:-localbiz-postgres}
PW='E2e-Test-Pass1!'
KNOWN=e2e-auth@localbiz.test
UNKNOWN=e2e-nobody@localbiz.test
A=$(mktemp); B=$(mktemp)
fail=0

sql() { docker exec -i "$DB_CONTAINER" psql -U localbiz -d localbiz -tAc "$1"; }
cleanup() {
  local owner="select id from users where email = '$KNOWN'"
  sql "delete from revoked_sessions where user_id in ($owner)" >/dev/null
  sql "delete from admin_activities where owner_id in ($owner)" >/dev/null
  sql "delete from otps where email in ('$KNOWN', '$UNKNOWN')" >/dev/null
  sql "delete from users where email = '$KNOWN'" >/dev/null
  rm -f "$A" "$B"
}
trap cleanup EXIT
cleanup

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected '$2', got '$3')"; fail=1; fi
}
post() { curl -s -w ' %{http_code}' -X POST "$API/$1" -H 'Content-Type: application/json' -d "$2"; }

curl -s -o /dev/null -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"fullName\":\"E2E Auth\",\"businessName\":\"E2E Auth Shop\",\"phone\":\"01700000007\",\"email\":\"$KNOWN\",\"password\":\"$PW\"}"
sql "update users set email_verified=true where email='$KNOWN'" >/dev/null
# Sign-up leaves its own code behind; start both addresses from the same state.
sql "delete from otps where email in ('$KNOWN', '$UNKNOWN')" >/dev/null

# --- 1. no account enumeration through password reset ----------------------
known=$(post auth/forgot-password "{\"email\":\"$KNOWN\"}")
unknown=$(post auth/forgot-password "{\"email\":\"$UNKNOWN\"}")
check "reset request answers the same for a known and an unknown email" "$known" "$unknown"

known=$(post auth/reset-password "{\"email\":\"$KNOWN\",\"otp\":\"000000\",\"password\":\"$PW\"}")
unknown=$(post auth/reset-password "{\"email\":\"$UNKNOWN\",\"otp\":\"000000\",\"password\":\"$PW\"}")
check "a wrong reset code answers the same for a known and an unknown email" "$known" "$unknown"

# --- 2. signing out ends the session on the server -------------------------
login() { curl -s -c "$1" -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$KNOWN\",\"password\":\"$PW\"}"; }
check "first sign-in" 200 "$(login "$A")"
check "second sign-in (another device)" 200 "$(login "$B")"
token() { awk -v name="$2" '$6 == name { print $7 }' "$1"; }
access=$(token "$A" lb_accessToken); refresh=$(token "$A" lb_refreshToken)

curl -s -b "$A" -o /dev/null -X POST "$API/auth/logout"
check "a copied access token is refused after sign-out" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: lb_accessToken=$access" "$API/auth/me")"
check "a copied refresh token is refused after sign-out" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: lb_refreshToken=$refresh" "$API/auth/refresh-token")"
check "the other device stays signed in" 200 \
  "$(curl -s -b "$B" -o /dev/null -w '%{http_code}' "$API/auth/me")"

exit $fail
