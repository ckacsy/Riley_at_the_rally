# Installation Instructions for Riley_at_the_rally

## Prerequisites
Before you begin, ensure you have met the following requirements:
- You have **Git** installed on your machine.
- You have **Node.js** version 18 or higher installed.

## Cloning the Repository
To clone the Riley_at_the_rally repository, run the following command in your terminal:
```bash
git clone https://github.com/ckacsy/Riley_at_the_rally.git
```

## Navigating to the Repository
Change into the project directory:
```bash
cd Riley_at_the_rally
```

## Installing Dependencies
The backend uses npm. Run:
```bash
cd backend
npm install
```

## Running the Project
To run the project, use the following command:
```bash
cd backend
npm start
```

The server starts on `http://localhost:5000`.

## Configuration
Copy `backend/.env.example` to `backend/.env` and edit the values for your environment:

```bash
cp backend/.env.example backend/.env
```

### Email Configuration

The backend sends transactional emails (email verification, magic-link login, password reset) via SMTP.  A full annotated example of every email-related variable is in `backend/.env.example`.

#### Setting up Gmail SMTP

1. Enable **2-Step Verification** on your Google account.
2. Go to **Google Account → Security → App passwords** and generate a new app password for the application (select "Mail" and your device type).
3. Set the following variables in `backend/.env`:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false          # false = STARTTLS (port 587); true = SSL (port 465)
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-gmail-app-password   # 16-character app password, not your normal password
MAIL_FROM="Riley RC" <your-email@gmail.com>
```

4. Set `NODE_ENV=production` and `APP_BASE_URL` to your public domain so that verification/magic-link URLs in emails point to the correct address:

```env
NODE_ENV=production
APP_BASE_URL=https://your-domain.com
```

#### DNS resolution behind VPN / Docker / WSL

In some environments (Outline VPN, Docker, WSL) the system DNS resolver is reachable from `nslookup` or PowerShell but **not** from the Node.js process itself.  The server automatically overrides the DNS servers used by Node.js to avoid this issue.

The default DNS servers are `8.8.8.8` and `8.8.4.4` (Google Public DNS).  You can override them with the `DNS_SERVERS` variable:

```env
# Comma-separated list of IP addresses
DNS_SERVERS=8.8.8.8,8.8.4.4
```

If you see an error like `queryA ETIMEOUT smtp.gmail.com` when starting the server, ensure you are either:
- Connected to a network where outbound DNS (UDP 53) is not blocked, **or**
- Set `DNS_SERVERS` in your `.env` to working public DNS servers, **or**
- Set `DISABLE_EMAIL=true` so SMTP is not attempted.

If DNS resolution is completely broken in your environment, you can connect by IP address instead of hostname.  First find the IP of `smtp.gmail.com` (e.g. `nslookup smtp.gmail.com` on another machine), then set:

```env
SMTP_HOST=142.250.102.108        # resolved IP of smtp.gmail.com
SMTP_TLS_SERVERNAME=smtp.gmail.com  # tells TLS to validate the certificate as smtp.gmail.com
```

`SMTP_TLS_SERVERNAME` is only needed when `SMTP_HOST` is an IP address; it lets Node.js validate the server's TLS certificate against the real hostname instead of the IP.

#### Switching between dev mode and production email

| Mode | Behaviour | How to enable |
|------|-----------|---------------|
| **Mail disabled** | Email content is printed to the server console; no real email is sent. | Set `DISABLE_EMAIL=true` **or** `NODE_ENV=test` |
| **Dev / default** | Email is attempted via SMTP, but `/api/dev/verification-link` and `/api/dev/magic-link` endpoints are also available as a fallback. | Leave `NODE_ENV` unset or set to anything other than `production` |
| **Production** | Email is sent via SMTP; dev endpoints are disabled. | Set `NODE_ENV=production` and configure SMTP vars |

> **Tip:** If `SMTP_HOST` is not set, the server will print a warning at startup and fall back to `localhost`, which will not deliver real email.  When `NODE_ENV` is not `production`, the server also stores the last-generated link in memory so you can retrieve it from `/api/dev/verification-link?email=…` even if SMTP is unavailable.

#### Disabling email entirely

Set `DISABLE_EMAIL=true` in your `.env`.  All emails will be printed to the server console instead of being delivered, regardless of SMTP settings.

## Additional Setup
- Ensure that any necessary environment variables are set in your `backend/.env` file as required by the application.
- Follow any further setup instructions as outlined in the project documentation.

## Troubleshooting
If you encounter issues, check the following:
- Ensure all dependencies are correctly installed.
- Check your Node.js version compatibility.
- Refer to the project’s issues page for any known bugs and fixes.

## Conclusion
You are now ready to start developing with the Riley_at_the_rally project!