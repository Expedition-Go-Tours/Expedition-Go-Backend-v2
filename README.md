# Expedition Go Backend v2

Production-ready tour booking platform backend built with Node.js, Express, Prisma, and Firebase Authentication.

## 🚀 Features

- **Multi-role Authentication**: Customer, Supplier, and Admin roles with Firebase integration
- **Tour Management**: Complete CRUD operations for tours with rich metadata
- **Booking System**: Full booking lifecycle with Stripe payment integration
- **Review System**: Customer reviews with moderation and supplier responses
- **Supplier Onboarding**: Complete supplier application and verification workflow
- **Notifications**: Real-time notifications for bookings, payments, and reviews
- **Stripe Integration**: Payment processing and supplier payouts via Stripe Connect
- **Comprehensive API Documentation**: Swagger/OpenAPI documentation at `/api-docs`

## 📋 Prerequisites

- Node.js (v16 or higher)
- PostgreSQL database
- Firebase project with Admin SDK credentials
- Stripe account for payments
- Cloudinary account for image uploads

## 🛠️ Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Expedition-Go-Tours/Expedition-Go-Backend-v2.git
   cd Expedition-Go-Backend-v2
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Create a `.env` file in the root directory:
   ```env
   # Database
   DATABASE_URL=postgresql://user:password@localhost:5432/expedition_go

   # Server
   PORT=5000
   NODE_ENV=development

   # Firebase Admin SDK
   FIREBASE_PROJECT_ID=your_project_id
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com

   # Stripe
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_COMMISSION_RATE=0.15

   # Cloudinary
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret

   # Email (Optional)
   EMAIL_HOST=smtp.gmail.com
   EMAIL_PORT=587
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASSWORD=your_app_password
   EMAIL_FROM=noreply@expeditiongo.com
   ```

4. **Run database migrations**
   ```bash
   npx prisma migrate deploy
   ```

5. **Generate Prisma Client**
   ```bash
   npx prisma generate
   ```

6. **Start the server**
   ```bash
   npm start
   ```

   The server will start at `http://localhost:5000`

## 📚 API Documentation

Once the server is running, visit:
- **Swagger UI**: http://localhost:5000/api-docs
- **OpenAPI Spec**: http://localhost:5000/api-docs.json

## 🔐 Authentication

This backend uses Firebase Authentication with custom token verification.

### Authentication Flow

1. User authenticates with Firebase on the frontend
2. Frontend gets Firebase ID token
3. Frontend calls `POST /api/users/signup` with the token
4. Backend verifies token and creates/retrieves user from database
5. Subsequent API calls include the Firebase token in the `Authorization` header

### Example Request

```javascript
const response = await fetch('http://localhost:5000/api/users/me', {
  headers: {
    'Authorization': `Bearer ${firebaseIdToken}`
  }
});
```

## 🗂️ Project Structure

```
├── config/              # Configuration files (Firebase, Cloudinary, Swagger)
├── controllers/         # Request handlers
├── middleware/          # Express middleware (auth, error handling, uploads)
├── models/              # (Empty - using Prisma)
├── prisma/              # Prisma schema and migrations
├── routes/              # API route definitions
├── utils/               # Helper functions and utilities
├── app.js               # Express app setup
├── server.js            # Server entry point
└── package.json         # Dependencies and scripts
```

## 🔑 Key Endpoints

### Authentication
- `POST /api/users/signup` - Create/get user profile (idempotent)
- `PATCH /api/users/sync-me` - Sync user with Firebase

### Tours
- `GET /api/tours` - List all tours (with filters)
- `GET /api/tours/:id` - Get tour details
- `POST /api/tours` - Create tour (supplier only)
- `PATCH /api/tours/:id` - Update tour (supplier only)

### Bookings
- `POST /api/bookings` - Create booking
- `GET /api/bookings/my-bookings` - Get user's bookings
- `PATCH /api/bookings/:id/cancel` - Cancel booking

### Reviews
- `POST /api/reviews` - Create review
- `GET /api/reviews/tour/:tourId` - Get tour reviews
- `PATCH /api/reviews/:id/respond` - Supplier response

### Suppliers
- `POST /api/suppliers/apply` - Submit supplier application
- `GET /api/suppliers/dashboard` - Supplier dashboard data
- `GET /api/suppliers/admin/applications` - Admin: view applications

## 🧪 Development

### Run in development mode with auto-reload
```bash
npm run dev
```

### Database commands
```bash
# Create a new migration
npx prisma migrate dev --name migration_name

# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Open Prisma Studio (database GUI)
npx prisma studio
```

## 🚢 Deployment

### Environment Variables
Ensure all production environment variables are set, especially:
- `NODE_ENV=production`
- Production database URL
- Production Stripe keys
- Production Firebase credentials

### Database Migration
```bash
npx prisma migrate deploy
```

### Start Production Server
```bash
npm start
```

## 🔒 Security Features

- Firebase token verification on all protected routes
- Role-based access control (RBAC)
- Input validation and sanitization
- SQL injection prevention via Prisma
- Secure password handling (Firebase)
- CORS configuration
- Rate limiting (recommended to add)
- Helmet.js for security headers (recommended to add)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is proprietary and confidential.

## 👥 Team

Expedition Go Tours Development Team

## 📧 Support

For support, email support@expeditiongo.com

---

**Last Updated**: May 12, 2026
**Version**: 2.0.0
