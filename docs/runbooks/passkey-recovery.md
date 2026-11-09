# Manual passkey recovery

Only for a member who has lost every passkey, an operator verifies the member's identity and allows them to register again. Being able to read the member's email is not enough for recovery. The record of earlier registration remains even after the keys are deleted, so the member does not go back to the first-registration path.

1. Receive the member's request and confirm it with the member through a known contact channel. Do not rely on the content of an email alone; use a check that an AI able to read the email could not imitate, such as a call with the known person. Record the method, the date and time, and who checked.
2. Confirm the database of the environment you run it in, `BETTER_AUTH_URL` and `OPERATOR_EMAILS`. The person running it must be a registered operator, with an account other than the member's.
3. Run the command below. The note must be 10 to 4000 characters. It is stored in the audit record of the recovery, so do not write answers to secret questions, ID numbers or the like.

```sh
pnpm exec tsx --env-file-if-exists=.env scripts/recover-passkeys.ts   operator@example.org member@example.org   'Confirmed the request and the lost device in a call with the known person. Date, time and checker recorded.'
```

For Docker Compose, run the same command inside the app container:

```sh
docker compose exec app pnpm exec tsx scripts/recover-passkeys.ts operator@example.org member@example.org \
  'Confirmed the request and the lost device in a call with the known person. Date, time and checker recorded.'
```

4. When the command succeeds, all of the member's sessions, all passkeys and the unused signing and registration challenges are invalidated. A 30-minute re-registration window opens and a recovery notice email is queued. The member logs in by email and registers a new passkey within 30 minutes. The recovery window closes after re-registration.
5. Ask the member to confirm logging in and signing with the new key. If the window has expired, the operator checks the identity record again before allowing recovery again. Do not work around this by deleting the registration record directly in the database.

If the notices of adding, deleting or recovering a passkey cannot be sent, the worker retries them. The operator checks the result of sending. Recovery does not delete the signatures on published posts, the copies of public keys or earlier revisions. The member's data export contains the evidence.

A passkey on another device through a QR code depends on Bluetooth and the platform's relay. Check supported platforms, Bluetooth availability, relay access and network restrictions on real devices used by the site's members before offering this recovery route. These are deployment conditions, independent of a test-site notice.
