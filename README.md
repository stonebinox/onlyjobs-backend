## Backend Notes

### Email notifications (Resend)
- Set `RESEND_API_KEY` in the backend environment.
- Optional: set `RESEND_FROM` (default: `onlyjobs <onboarding@resend.dev>` - you'll need to verify your own domain in Resend for production).
- Matching runs send a daily summary email when matches are created (top 5 included) and mention the $0.30 wallet deduction. Email failures are logged but do not block matching.
