# HireLoop Server 🚀

Backend API for **HireLoop**, a modern job marketplace platform that connects **job seekers** with **recruiters**.

The server provides secure authentication, job management, job applications, saved jobs, recruiter applicant management, billing with Stripe, and admin controls.

## 🌐 Live Server

**API Base URL:**  
https://hire-loop-server-rust.vercel.app/

**Server Status:**  
`HireLoop Server Running`

---

## ✨ Features

- 🔐 JWT/JWKS-based user authentication
- 👤 Role-based access control
  - Seeker
  - Recruiter
  - Admin
- 💼 Create, update, view, and delete jobs
- 🔎 Browse all available jobs
- 📄 View individual job details
- 📌 Save and unsave jobs
- 📝 Apply for jobs
- ✅ Check application status
- 👨‍💼 Recruiter application management
- 👥 View applicants for recruiter jobs
- 🔄 Update application status
- 💳 Stripe checkout and billing integration
- 🔔 Stripe webhook support
- 👑 Admin user management
- 🛡️ Admin role management
- 🗄️ MongoDB database integration
- ☁️ Vercel serverless deployment
- 🌐 CORS-enabled API

---

## 🛠️ Technologies

- **Node.js**
- **Express.js**
- **TypeScript**
- **MongoDB**
- **MongoDB Node.js Driver**
- **JWT / JOSE**
- **JWKS**
- **Stripe**
- **CORS**
- **dotenv**
- **Vercel**

---

## 📁 Project Structure

```text
hire-loop-server/
│
├── api/
│   └── index.ts
│
├── config/
│   ├── db.ts
│   ├── db.js
│   ├── db.d.ts
│   └── db.js.map
│
├── middleware/
│   ├── auth.ts
│   ├── auth.js
│   └── auth.d.ts
│
├── index.ts
├── package.json
├── package-lock.json
├── tsconfig.json
├── vercel.json
├── .env.example
└── .gitignore
```

---

## 🔐 Authentication

HireLoop uses JWT authentication with JWKS verification.

Protected requests require an Authorization header:

```http
Authorization: Bearer <JWT_TOKEN>
```

The backend verifies:

- JWT signature
- Issuer
- Audience
- User ID
- User existence
- User role

Supported roles:

```text
seeker
recruiter
admin
```

### Role Permissions

| Role | Main Permissions |
|---|---|
| Seeker | Browse jobs, save jobs, apply for jobs |
| Recruiter | Create/manage jobs, view applicants, update applications |
| Admin | Manage users and administrative resources |

---

## 💼 Jobs API

### Get All Jobs

```http
GET /api/jobs
```

Returns available jobs sorted by creation date.

### Get Single Job

```http
GET /api/jobs/:id
```

### Create Job

```http
POST /api/jobs
```

**Authentication:** Recruiter

### Update Job

```http
PATCH /api/jobs/:id
```

**Authentication:** Recruiter

### Delete Job

```http
DELETE /api/jobs/:id
```

**Authentication:** Recruiter

Recruiters can manage their own jobs.

---

## 📌 Saved Jobs API

### Save a Job

```http
POST /api/saved-jobs
```

**Authentication:** Seeker

### Get Saved Jobs

```http
GET /api/saved-jobs
```

**Authentication:** Seeker

### Check Saved Job

```http
GET /api/saved-jobs/check/:jobId
```

**Authentication:** Seeker

### Remove Saved Job

```http
DELETE /api/saved-jobs/:jobId
```

**Authentication:** Seeker

---

## 📝 Applications API

### Check Application

```http
GET /api/applications/check
```

**Authentication:** Seeker

### Apply for a Job

```http
POST /api/applications
```

**Authentication:** Seeker

### Get Recruiter Applications

```http
GET /api/applications/recruiter
```

**Authentication:** Recruiter

### Get Applicants for a Job

```http
GET /api/applications/recruiter/:jobId
```

**Authentication:** Recruiter

### Update Application Status

```http
PATCH /api/applications/:id/status
```

**Authentication:** Recruiter

---

## 💳 Billing & Stripe

HireLoop integrates Stripe for subscription/payment functionality.

### Billing Summary

```http
GET /api/billing/summary
```

### Create Checkout Session

```http
POST /api/billing/checkout-session
```

### Frontend-Compatible Checkout Session

```http
POST /api/billing/create-checkout-session
```

### Stripe Webhook

```http
POST /api/stripe/webhook
```

The Stripe webhook uses raw JSON body parsing and must be registered before the normal Express JSON middleware.

---

## 👑 Admin API

### Get Users

```http
GET /api/admin/users
```

**Authentication:** Admin

### Update User Role

```http
PATCH /api/admin/users/:id/role
```

**Authentication:** Admin

### Delete Job as Admin

```http
DELETE /api/admin/jobs/:id
```

**Authentication:** Admin

---

## 🗄️ Database

HireLoop uses **MongoDB** as its database.

The server connects to MongoDB using the MongoDB Node.js driver.

The database name can be configured using:

```env
DB_NAME=hireloop
```

If `DB_NAME` is not provided, the server uses:

```text
hireloop
```

---

## ⚙️ Environment Variables

Create a `.env` file in the project root.

Example:

```env
MONGODB_URI=your_mongodb_connection_string
DB_NAME=hireloop

AUTH_BASE_URL=https://your-auth-domain.com
AUTH_JWT_ISSUER=https://your-auth-domain.com
AUTH_JWT_AUDIENCE=https://your-auth-domain.com

STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
```

> Never commit your real `.env` file or secret keys to GitHub.

---

## 🚀 Local Development

### 1. Clone the repository

```bash
git clone https://github.com/fahimrahat58/hire-loop-server.git
```

### 2. Enter the project

```bash
cd hire-loop-server
```

### 3. Install dependencies

```bash
npm install
```

### 4. Configure environment variables

Create:

```text
.env
```

and add the required MongoDB, authentication, and Stripe credentials.

### 5. Start development server

```bash
npm run dev
```

---

## 🏗️ Build

To compile the TypeScript project:

```bash
npm run build
```

---

## ▶️ Production

```bash
npm start
```

---

## ☁️ Deployment

The backend is configured for **Vercel** deployment.

The project uses:

```text
api/index.ts
```

as the Vercel serverless entry point.

Deployment configuration is defined in:

```text
vercel.json
```

### Live Deployment

https://hire-loop-server-rust.vercel.app/

---

## 🔒 Security

HireLoop implements several security measures:

- JWT signature verification
- JWKS-based public key validation
- Issuer validation
- Audience validation
- MongoDB user verification
- Role-based authorization
- Protected recruiter routes
- Protected seeker routes
- Protected admin routes
- Stripe webhook signature verification
- Environment-based secret configuration

---

## 📡 API Response Style

The API generally returns JSON responses containing fields such as:

```json
{
  "success": true,
  "message": "Operation successful"
}
```

Error responses follow a similar structure:

```json
{
  "success": false,
  "message": "Error message"
}
```

---

## 🎯 Project Goal

HireLoop is designed to simplify the hiring process by providing a single platform where:

**Job Seekers can:**

- Discover jobs
- Save interesting jobs
- Apply for jobs
- Track applications

**Recruiters can:**

- Publish jobs
- Manage job postings
- View applicants
- Update application status

**Admins can:**

- Manage users
- Manage roles
- Manage platform resources

---

## 🔗 Related Project

### HireLoop Client

Frontend application for the HireLoop platform.

**GitHub:**  
https://github.com/fahimrahat58/hire-loop-client

---

## 👨‍💻 Developer

**Fahim Muntasir Rahat**

Full-Stack Web Developer  
Specialized in modern web applications, Next.js, Node.js, Express.js, MongoDB, and WordPress.

---

## 📄 License

This project is developed for the HireLoop platform.
