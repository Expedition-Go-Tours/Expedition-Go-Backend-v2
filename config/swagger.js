/**
 * Comprehensive Swagger Configuration - Production Ready
 * Complete API documentation with detailed schemas, examples, and descriptions
 * 
 * @author Tour Platform Team
 * @version 2.0.0
 */

const swaggerJSDoc = require('swagger-jsdoc');
const path = require('path');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Expedition Go Tours API',
      version: '2.0.0',
      description: `
# Expedition Go Tours API Documentation

## Overview
Production-ready tour booking platform API with comprehensive features including:
- **Multi-role authentication** (Customer, Supplier, Admin)
- **Tour management** with complex pricing and scheduling
- **Booking system** with cart functionality and direct booking
- **Payment processing** with Stripe integration and commission splits
- **Review system** with supplier responses and moderation
- **Supplier verification** with document management and payout methods
- **Real-time notifications** via WebSocket
- **File uploads** with Cloudinary integration
- **Comprehensive audit logging** for all operations

## Analytics & Event Tracking
The platform includes a production-grade analytics system:
- **Structured event tracking** — every user action emits a named event (e.g., \`user.signed_up\`, \`tour.viewed\`, \`booking.completed\`) with typed properties
- **Event model** — all events are persisted in the \`Event\` table with indexes optimized for funnel and time-series queries
- **Background job processing** — BullMQ queues decouple email delivery, notifications, and scheduled aggregation from the request cycle
- **Admin analytics dashboard** — platform-wide endpoints for revenue, booking volume, funnel analysis, CLV, search analytics, and cart abandonment
- **Search analytics** — tracks every query, identifies zero-result searches (unmet demand), and measures search-to-booking conversion
- **Cart abandonment tracking** — expired carts emit \`cart.abandoned\` events for real-time tracking and future reminder flows

## Admin Analytics Endpoints
All analytics endpoints require \`admin\` role and are available at \`/api/admin/analytics/*\`:

| Endpoint | Purpose |
|---|---|
| \`/analytics/overview\` | Platform snapshot (revenue, bookings, signups, top tours/suppliers) |
| \`/analytics/revenue-trend\` | Monthly revenue + commission (last 24 months) |
| \`/analytics/user-growth\` | Monthly signups by role (last 24 months) |
| \`/analytics/tour-performance\` | Paginated tour metrics (sortable, filterable) |
| \`/analytics/funnel\` | Booking conversion funnel (view → cart → checkout → complete) |
| \`/analytics/clv\` | Customer Lifetime Value, repeat rate, cohorts |
| \`/analytics/search\` | Top queries, zero-result detection, search outcomes |
| \`/analytics/cart-abandonment\` | Abandonment rate, per-tour breakdown, daily trend |

## Authentication
All protected endpoints require a Firebase JWT token in the Authorization header:
\`\`\`
Authorization: Bearer <firebase-jwt-token>
\`\`\`

For development testing, use:
\`\`\`
Authorization: Bearer test-token
\`\`\`

## Rate Limiting
- **100 requests per 15 minutes** per IP address
- **20 requests per 15 minutes** on auth endpoints
- Rate limit headers included in responses

## Error Handling
All errors follow a consistent format:
\`\`\`json
{
  "status": "fail|error",
  "message": "Human readable error message",
  "error": {
    "statusCode": 400,
    "status": "fail",
    "isOperational": true
  }
}
\`\`\`

## Pagination
List endpoints support pagination with consistent parameters:
- \`page\`: Page number (default: 1)
- \`limit\`: Items per page (default: 10-20 depending on endpoint)

Response includes pagination metadata:
\`\`\`json
{
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "totalCount": 50,
    "hasNextPage": true,
    "hasPrevPage": false,
    "limit": 10
  }
}
\`\`\`

## WebSocket Events
Real-time notifications are sent via WebSocket for:
- New bookings
- Booking status changes
- Review submissions and supplier responses
- Supplier status updates
- Payment confirmations
- Admin alerts

Connect to: \`ws://localhost:5000\` or \`wss://your-domain.com\`
      `,
      termsOfService: 'https://expeditiongo.com/terms',
      contact: {
        name: 'API Support Team',
        email: 'support@expeditiongo.com',
        url: 'https://expeditiongo.com/support'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    externalDocs: {
      description: 'Find more info here',
      url: 'https://docs.expeditiongo.com'
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Development server - Local development environment'
      },
      {
        url: 'https://expedition-go-backend-v2.onrender.com',
        description: 'Production server - Live production environment'
      },
      {
        url: 'https://staging-api.expeditiongo.com',
        description: 'Staging server - Testing environment'
      }
    ],
    tags: [
      {
        name: 'Authentication',
        description: 'User authentication and account management'
      },
      {
        name: 'Users',
        description: 'User profile management and preferences'
      },
      {
        name: 'Tours',
        description: 'Tour creation, management, and public browsing'
      },
      {
        name: 'Bookings',
        description: 'Booking process, cart management, and payment'
      },
      {
        name: 'Reviews',
        description: 'Customer reviews and supplier responses'
      },
      {
        name: 'Suppliers',
        description: 'Supplier verification, onboarding, and management'
      },
      {
        name: 'Notifications',
        description: 'Real-time notification management'
      },
      {
        name: 'Webhooks',
        description: 'External service webhooks (Stripe, etc.)'
      },
      {
        name: 'Admin',
        description: 'Administrative functions and moderation'
      },
      {
        name: 'Analytics',
        description: 'Business analytics and reporting'
      },
      {
        name: 'Payouts',
        description: 'Supplier payout management (treasury model)'
      },
      {
        name: 'Payout Methods',
        description: 'Supplier payout method configuration'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Firebase JWT token obtained from Firebase Authentication'
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key for server-to-server communication'
        }
      },
      parameters: {
        userId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Unique user identifier (CUID)',
          schema: {
            type: 'string',
            pattern: '^c[a-z0-9]{24}$',
            example: 'cmp2h5edn0000wrs1gfllik7m'
          }
        },
        tourId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Unique tour identifier (CUID) or slug',
          schema: {
            type: 'string',
            example: 'cmp2hql3c0001tzv0460pbckm'
          }
        },
        bookingId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Unique booking identifier (CUID)',
          schema: {
            type: 'string',
            pattern: '^c[a-z0-9]{24}$',
            example: 'cmp2hql3c0001tzv0460pbckm'
          }
        },
        reviewId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Unique review identifier (CUID)',
          schema: {
            type: 'string',
            pattern: '^c[a-z0-9]{24}$',
            example: 'cmp2hql3c0001tzv0460pbckm'
          }
        },
        supplierId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Unique supplier profile identifier (CUID)',
          schema: {
            type: 'string',
            pattern: '^c[a-z0-9]{24}$',
            example: 'cmp2himz40001iwkfib3ld8to'
          }
        },
        pageParam: {
          name: 'page',
          in: 'query',
          description: 'Page number for pagination (1-based)',
          schema: {
            type: 'integer',
            minimum: 1,
            default: 1,
            example: 1
          }
        },
        limitParam: {
          name: 'limit',
          in: 'query',
          description: 'Number of items per page',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 10,
            example: 10
          }
        },
        sortByParam: {
          name: 'sortBy',
          in: 'query',
          description: 'Field to sort by',
          schema: {
            type: 'string',
            enum: ['createdAt', 'updatedAt', 'name', 'rating', 'price', 'popularity'],
            default: 'createdAt',
            example: 'createdAt'
          }
        },
        sortOrderParam: {
          name: 'sortOrder',
          in: 'query',
          description: 'Sort order direction',
          schema: {
            type: 'string',
            enum: ['asc', 'desc'],
            default: 'desc',
            example: 'desc'
          }
        }
      },
      schemas: {
        // ================================
        // USER SCHEMAS
        // ================================
        User: {
          type: 'object',
          description: 'User account with multi-role support',
          required: ['id', 'firebaseUid', 'name', 'email', 'roles'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique user identifier (CUID)',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m'
            },
            firebaseUid: {
              type: 'string',
              description: 'Firebase Authentication UID',
              example: 'firebase-uid-123'
            },
            name: {
              type: 'string',
              description: 'User full name',
              minLength: 1,
              maxLength: 100,
              example: 'John Doe'
            },
            email: {
              type: 'string',
              format: 'email',
              description: 'User email address (unique)',
              example: 'john.doe@example.com'
            },
            photoURL: {
              type: 'string',
              format: 'uri',
              description: 'Profile photo URL (Cloudinary)',
              example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/users/profile.jpg'
            },
            phone: {
              type: 'string',
              description: 'Phone number in international format',
              pattern: '^\\+?[1-9]\\d{1,14}$',
              example: '+1234567890',
              nullable: true
            },
            roles: {
              type: 'array',
              description: 'User roles (supports multiple roles)',
              items: {
                type: 'string',
                enum: ['customer', 'supplier', 'admin']
              },
              minItems: 1,
              example: ['customer', 'supplier']
            },
            stripeCustomerId: {
              type: 'string',
              description: 'Stripe customer ID for payments',
              pattern: '^cus_[a-zA-Z0-9]+$',
              example: 'cus_1234567890abcdef',
              nullable: true
            },
            wishlist: {
              type: 'array',
              description: 'Array of tour IDs in user wishlist',
              items: {
                type: 'string',
                pattern: '^c[a-z0-9]{24}$'
              },
              example: ['cmp2hql3c0001tzv0460pbckm', 'cmp2hql3c0001tzv0460pbckn']
            },
            likes: {
              type: 'array',
              description: 'Array of tour IDs user has liked',
              items: {
                type: 'string',
                pattern: '^c[a-z0-9]{24}$'
              },
              example: ['cmp2hql3c0001tzv0460pbckm']
            },
            language: {
              type: 'string',
              description: 'Preferred language (ISO 639-1)',
              pattern: '^[a-z]{2}$',
              default: 'en',
              example: 'en'
            },
            timezone: {
              type: 'string',
              description: 'User timezone (IANA timezone)',
              default: 'UTC',
              example: 'America/New_York'
            },
            active: {
              type: 'boolean',
              description: 'Account active status',
              default: true,
              example: true
            },
            emailVerified: {
              type: 'boolean',
              description: 'Email verification status',
              default: false,
              example: true
            },
            lastLoginAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last login timestamp',
              example: '2026-05-12T10:15:06.251Z',
              nullable: true
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Account creation timestamp',
              example: '2026-05-12T10:15:06.251Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
              example: '2026-05-12T10:25:23.937Z'
            }
          },
          example: {
            id: 'cmp2h5edn0000wrs1gfllik7m',
            firebaseUid: 'firebase-uid-123',
            name: 'John Doe',
            email: 'john.doe@example.com',
            photoURL: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/users/profile.jpg',
            phone: '+1234567890',
            roles: ['customer', 'supplier'],
            stripeCustomerId: 'cus_1234567890abcdef',
            wishlist: ['cmp2hql3c0001tzv0460pbckm'],
            likes: ['cmp2hql3c0001tzv0460pbckm'],
            language: 'en',
            timezone: 'America/New_York',
            active: true,
            emailVerified: true,
            lastLoginAt: '2026-05-12T10:15:06.251Z',
            createdAt: '2026-05-12T10:15:06.251Z',
            updatedAt: '2026-05-12T10:25:23.937Z'
          }
        },
        UserInput: {
          type: 'object',
          description: 'User input for creation/update',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              example: 'John Doe'
            },
            phone: {
              type: 'string',
              pattern: '^\\+?[1-9]\\d{1,14}$',
              example: '+1234567890'
            },
            language: {
              type: 'string',
              pattern: '^[a-z]{2}$',
              example: 'en'
            },
            timezone: {
              type: 'string',
              example: 'America/New_York'
            }
          }
        },
        // ================================
        // SUPPLIER SCHEMAS
        // ================================
        SupplierProfile: {
          type: 'object',
          description: 'Comprehensive supplier profile with verification details',
          required: ['id', 'userId', 'status'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique supplier profile identifier',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2himz40001iwkfib3ld8to'
            },
            userId: {
              type: 'string',
              description: 'Associated user ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m'
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'REJECTED'],
              description: 'Supplier verification status',
              example: 'ACTIVE'
            },
            businessInfo: {
              type: 'object',
              description: 'Business information and legal details',
              required: ['legalBusinessName', 'displayName', 'businessType', 'country', 'address'],
              properties: {
                legalBusinessName: {
                  type: 'string',
                  description: 'Legal registered business name',
                  minLength: 1,
                  maxLength: 200,
                  example: 'Adventure Tours Ltd'
                },
                displayName: {
                  type: 'string',
                  description: 'Public display name for customers',
                  minLength: 1,
                  maxLength: 100,
                  example: 'Adventure Tours'
                },
                businessType: {
                  type: 'string',
                  enum: ['individual', 'company', 'non_profit'],
                  description: 'Type of business entity',
                  example: 'company'
                },
                country: {
                  type: 'string',
                  description: 'Country code (ISO 3166-1 alpha-2)',
                  pattern: '^[A-Z]{2}$',
                  example: 'US'
                },
                address: {
                  type: 'object',
                  description: 'Business address',
                  required: ['line1', 'city', 'state', 'postalCode'],
                  properties: {
                    line1: {
                      type: 'string',
                      description: 'Address line 1',
                      example: '123 Main Street'
                    },
                    line2: {
                      type: 'string',
                      description: 'Address line 2 (optional)',
                      example: 'Suite 100'
                    },
                    city: {
                      type: 'string',
                      description: 'City name',
                      example: 'New York'
                    },
                    state: {
                      type: 'string',
                      description: 'State/Province',
                      example: 'NY'
                    },
                    postalCode: {
                      type: 'string',
                      description: 'Postal/ZIP code',
                      example: '10001'
                    }
                  }
                },
                website: {
                  type: 'string',
                  format: 'uri',
                  description: 'Business website URL',
                  example: 'https://adventuretours.com'
                },
                phoneNumber: {
                  type: 'string',
                  description: 'Business phone number',
                  pattern: '^\\+?[1-9]\\d{1,14}$',
                  example: '+1-555-123-4567'
                }
              }
            },
            operatingInfo: {
              type: 'object',
              description: 'Tour operating information and capabilities',
              required: ['tourCategories', 'destinations', 'languages', 'cancellationPolicy', 'meetingStyle'],
              properties: {
                tourCategories: {
                  type: 'array',
                  description: 'Types of tours offered',
                  items: {
                    type: 'string',
                    enum: ['Adventure', 'Cultural', 'Nature', 'Historical', 'Food & Drink', 'Photography', 'Family', 'Luxury', 'Budget', 'Group', 'Private']
                  },
                  minItems: 1,
                  example: ['Adventure', 'Cultural', 'Nature']
                },
                destinations: {
                  type: 'array',
                  description: 'Geographic areas served',
                  items: {
                    type: 'string'
                  },
                  minItems: 1,
                  example: ['New York', 'California', 'Florida']
                },
                languages: {
                  type: 'array',
                  description: 'Languages spoken by guides',
                  items: {
                    type: 'string',
                    pattern: '^[A-Z][a-z]+$'
                  },
                  minItems: 1,
                  example: ['English', 'Spanish', 'French']
                },
                yearsInBusiness: {
                  type: 'integer',
                  description: 'Years of experience in tourism',
                  minimum: 0,
                  maximum: 100,
                  example: 5
                },
                cancellationPolicy: {
                  type: 'string',
                  description: 'Standard cancellation policy',
                  minLength: 10,
                  maxLength: 500,
                  example: 'Free cancellation up to 24 hours before tour start time'
                },
                meetingStyle: {
                  type: 'string',
                  enum: ['pickup', 'meeting_point', 'flexible'],
                  description: 'How customers meet the guide',
                  example: 'pickup'
                }
              }
            },
            representativeInfo: {
              type: 'object',
              description: 'Legal representative information for verification',
              required: ['fullName', 'email', 'dateOfBirth', 'address', 'idType', 'idDocumentUrl'],
              properties: {
                fullName: {
                  type: 'string',
                  description: 'Full legal name of representative',
                  minLength: 2,
                  maxLength: 100,
                  example: 'John Smith'
                },
                email: {
                  type: 'string',
                  format: 'email',
                  description: 'Representative email address',
                  example: 'john@adventuretours.com'
                },
                dateOfBirth: {
                  type: 'string',
                  format: 'date',
                  description: 'Date of birth (must be 18+ years old)',
                  example: '1985-06-15'
                },
                address: {
                  type: 'object',
                  description: 'Representative residential address',
                  required: ['line1', 'city', 'state', 'postalCode'],
                  properties: {
                    line1: { type: 'string', example: '456 Oak Avenue' },
                    line2: { type: 'string', example: 'Apt 2B' },
                    city: { type: 'string', example: 'New York' },
                    state: { type: 'string', example: 'NY' },
                    postalCode: { type: 'string', example: '10002' }
                  }
                },
                idType: {
                  type: 'string',
                  enum: ['passport', 'drivers_license', 'national_id'],
                  description: 'Type of identification document',
                  example: 'passport'
                },
                idDocumentUrl: {
                  type: 'string',
                  format: 'uri',
                  description: 'URL to uploaded ID document (Cloudinary)',
                  example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/documents/passport.pdf'
                }
              }
            },
            businessDocuments: {
              type: 'object',
              description: 'Required business verification documents',
              required: ['registrationDocumentUrl', 'taxDocumentUrl', 'proofOfAddressUrl'],
              properties: {
                registrationDocumentUrl: {
                  type: 'string',
                  format: 'uri',
                  description: 'Business registration certificate URL',
                  example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/documents/registration.pdf'
                },
                taxDocumentUrl: {
                  type: 'string',
                  format: 'uri',
                  description: 'Tax identification document URL',
                  example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/documents/tax.pdf'
                },
                proofOfAddressUrl: {
                  type: 'string',
                  format: 'uri',
                  description: 'Proof of business address URL',
                  example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/documents/address.pdf'
                },
                licenses: {
                  type: 'array',
                  description: 'Additional business licenses (optional)',
                  items: {
                    type: 'string',
                    format: 'uri'
                  },
                  example: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/documents/license1.pdf']
                }
              }
            },
            payoutInfo: {
              type: 'object',
              description: 'Bank account information for payouts',
              required: ['bankAccountName', 'bankCountry', 'payoutCurrency'],
              properties: {
                bankAccountName: {
                  type: 'string',
                  description: 'Name on bank account',
                  example: 'Adventure Tours Ltd'
                },
                bankCountry: {
                  type: 'string',
                  description: 'Bank country code (ISO 3166-1 alpha-2)',
                  pattern: '^[A-Z]{2}$',
                  example: 'US'
                },
                payoutCurrency: {
                  type: 'string',
                  description: 'Preferred payout currency (ISO 4217)',
                  pattern: '^[A-Z]{3}$',
                  example: 'USD'
                },
              }
            },
            compliance: {
              type: 'object',
              description: 'Legal compliance and verification status',
              required: ['acceptedTerms', 'agreedToPayoutTerms'],
              properties: {
                acceptedTerms: {
                  type: 'boolean',
                  description: 'Accepted platform terms of service',
                  example: true
                },
                agreedToPayoutTerms: {
                  type: 'boolean',
                  description: 'Agreed to payout terms and commission structure',
                  example: true
                },
                verified: {
                  type: 'boolean',
                  description: 'Admin verification completed',
                  default: false,
                  example: true
                },
                reviewStatus: {
                  type: 'string',
                  enum: ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED'],
                  description: 'Admin review status',
                  default: 'PENDING',
                  example: 'APPROVED'
                }
              }
            },
            adminNotes: {
              type: 'string',
              description: 'Admin notes from review process',
              maxLength: 1000,
              example: 'Application looks good. All documents verified.',
              nullable: true
            },
            reviewedBy: {
              type: 'string',
              description: 'Admin user ID who reviewed the application',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m',
              nullable: true
            },
            reviewedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Timestamp of admin review',
              example: '2026-05-12T10:25:56.438Z',
              nullable: true
            },
            totalEarnings: {
              type: 'number',
              format: 'decimal',
              description: 'Total earnings to date (USD)',
              minimum: 0,
              example: 1250.75
            },
            totalBookings: {
              type: 'integer',
              description: 'Total number of completed bookings',
              minimum: 0,
              example: 42
            },
            averageRating: {
              type: 'number',
              format: 'decimal',
              description: 'Average customer rating (1-5 scale)',
              minimum: 1,
              maximum: 5,
              example: 4.8,
              nullable: true
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Application submission timestamp',
              example: '2026-05-12T10:25:23.921Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
              example: '2026-05-12T10:30:01.529Z'
            }
          }
        },
        SupplierApplication: {
          type: 'object',
          description: 'Supplier application input data',
          required: ['businessInfo', 'operatingInfo', 'representativeInfo', 'businessDocuments', 'payoutInfo'],
          properties: {
            businessInfo: { $ref: '#/components/schemas/SupplierProfile/properties/businessInfo' },
            operatingInfo: { $ref: '#/components/schemas/SupplierProfile/properties/operatingInfo' },
            representativeInfo: { $ref: '#/components/schemas/SupplierProfile/properties/representativeInfo' },
            businessDocuments: { $ref: '#/components/schemas/SupplierProfile/properties/businessDocuments' },
            payoutInfo: { $ref: '#/components/schemas/SupplierProfile/properties/payoutInfo' },
            compliance: { $ref: '#/components/schemas/SupplierProfile/properties/compliance' }
          }
        },
        // ================================
        // TOUR SCHEMAS
        // ================================
        Tour: {
          type: 'object',
          description: 'Complete tour information with pricing and scheduling',
          required: ['id', 'supplierId', 'title', 'description', 'status', 'categorization', 'schedulesAndPricing'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique tour identifier',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            supplierId: {
              type: 'string',
              description: 'Tour supplier user ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m'
            },
            title: {
              type: 'string',
              description: 'Tour title (SEO optimized)',
              minLength: 10,
              maxLength: 200,
              example: 'Amazing Central Park Walking Tour'
            },
            description: {
              type: 'string',
              description: 'Detailed tour description',
              minLength: 50,
              maxLength: 5000,
              example: 'Discover the hidden gems of Central Park with our expert local guide. This comprehensive 2-hour walking tour covers the most iconic spots and secret locations that most tourists never see.'
            },
            photos: {
              type: 'array',
              description: 'Tour photos (Cloudinary URLs)',
              items: {
                type: 'string',
                format: 'uri'
              },
              maxItems: 20,
              example: [
                'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/tours/central-park-1.jpg',
                'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/tours/central-park-2.jpg'
              ]
            },
            status: {
              type: 'string',
              enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'],
              description: 'Tour publication status',
              example: 'ACTIVE'
            },
            categorization: {
              type: 'object',
              description: 'Tour categorization and classification',
              required: ['category', 'duration'],
              properties: {
                category: {
                  type: 'string',
                  enum: ['Adventure', 'Cultural', 'Nature', 'Historical', 'Food & Drink', 'Photography', 'Family', 'Luxury', 'Budget', 'Group', 'Private'],
                  description: 'Primary tour category',
                  example: 'Cultural'
                },
                subcategory: {
                  type: 'string',
                  description: 'Specific tour type',
                  example: 'Walking Tours'
                },
                difficulty: {
                  type: 'string',
                  enum: ['Easy', 'Moderate', 'Challenging', 'Expert'],
                  description: 'Physical difficulty level',
                  example: 'Easy'
                },
                duration: {
                  type: 'integer',
                  description: 'Tour duration in minutes',
                  minimum: 30,
                  maximum: 1440,
                  example: 120
                },
                groupSize: {
                  type: 'object',
                  description: 'Group size constraints',
                  properties: {
                    min: {
                      type: 'integer',
                      minimum: 1,
                      example: 2
                    },
                    max: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 50,
                      example: 15
                    }
                  }
                },
                transportMode: {
                  type: 'object',
                  description: 'Transportation modes grouped by type',
                  properties: {
                    air: {
                      type: 'array',
                      description: 'Air transport modes',
                      items: { type: 'string', enum: ['Biplane', 'Glider', 'Plane', 'Helicopter', 'Hot Air Balloon', 'Parachute'] },
                      example: ['Plane', 'Helicopter']
                    },
                    land: {
                      type: 'array',
                      description: 'Land transport modes',
                      items: { type: 'string', enum: ['Bicycle', 'Buggy', '4x4/Jeep', 'Bus', 'Car', 'Camel', 'Horseback', 'Motorcycle', 'Walking', 'Train', 'Scooter'] },
                      example: ['4x4/Jeep', 'Walking']
                    },
                    water: {
                      type: 'array',
                      description: 'Water transport modes',
                      items: { type: 'string', enum: ['Boat', 'Cruise Ship', 'Kayak', 'Raft', 'Submarine', 'Surfboard', 'Yacht', 'Ferry'] },
                      example: ['Boat', 'Kayak']
                    }
                  },
                  example: { land: ['4x4/Jeep', 'Walking'], air: ['Plane'] }
                }
              }
            },
            theme: {
              type: 'object',
              description: 'Tour themes and tags for discovery',
              properties: {
                primary: {
                  type: 'string',
                  description: 'Main theme',
                  example: 'Nature & Parks'
                },
                secondary: {
                  type: 'array',
                  description: 'Additional themes',
                  items: { type: 'string' },
                  example: ['History', 'Photography']
                },
                tags: {
                  type: 'array',
                  description: 'Searchable tags',
                  items: { type: 'string' },
                  maxItems: 10,
                  example: ['family-friendly', 'instagram-worthy', 'local-guide']
                }
              }
            },
            productContent: {
              type: 'object',
              description: 'Detailed tour content and inclusions',
              properties: {
                highlights: {
                  type: 'array',
                  description: 'Key tour highlights',
                  items: { type: 'string' },
                  example: [
                    'Visit Bethesda Fountain and Terrace',
                    'Explore the Shakespeare Garden',
                    'See the famous Bow Bridge',
                    'Learn about Central Park history'
                  ]
                },
                included: {
                  type: 'array',
                  description: 'What is included in the tour',
                  items: { type: 'string' },
                  example: [
                    'Professional local guide',
                    'Small group experience',
                    'Photo opportunities'
                  ]
                },
                excluded: {
                  type: 'array',
                  description: 'What is not included',
                  items: { type: 'string' },
                  example: [
                    'Food and drinks',
                    'Transportation to meeting point'
                  ]
                },
                whatToBring: {
                  type: 'array',
                  description: 'Items customers should bring',
                  items: { type: 'string' },
                  example: [
                    'Comfortable walking shoes',
                    'Weather-appropriate clothing',
                    'Camera or smartphone'
                  ]
                }
              }
            },
            schedulesAndPricing: {
              type: 'object',
              description: 'Complex pricing and scheduling information',
              required: ['travelerDetails', 'pricingSchedules'],
              properties: {
                travelerDetails: {
                  type: 'object',
                  description: 'Traveler categorization and limits',
                  required: ['pricingModel', 'maxTravelersPerBooking', 'ageGroups'],
                  properties: {
                    pricingModel: {
                      type: 'string',
                      enum: ['group', 'perPerson', 'perBooking'],
                      description: 'How pricing is calculated',
                      example: 'perPerson'
                    },
                    maxTravelersPerBooking: {
                      type: 'integer',
                      description: 'Maximum travelers per single booking',
                      minimum: 1,
                      maximum: 50,
                      example: 15
                    },
                    ageGroups: {
                      type: 'array',
                      description: 'Age-based pricing categories',
                      items: {
                        type: 'object',
                        required: ['label', 'minAge', 'maxAge'],
                        properties: {
                          label: {
                            type: 'string',
                            description: 'Age group name',
                            example: 'Adult'
                          },
                          minAge: {
                            type: 'integer',
                            minimum: 0,
                            maximum: 120,
                            description: 'Minimum age for this category',
                            example: 13
                          },
                          maxAge: {
                            type: 'integer',
                            minimum: 0,
                            maximum: 120,
                            description: 'Maximum age for this category',
                            example: 99
                          }
                        }
                      },
                      minItems: 1,
                      example: [
                        { label: 'Adult', minAge: 13, maxAge: 99 },
                        { label: 'Child', minAge: 6, maxAge: 12 },
                        { label: 'Infant', minAge: 0, maxAge: 5 }
                      ]
                    }
                  }
                },
                pricingSchedules: {
                  type: 'object',
                  description: 'Time-based pricing schedules',
                  required: ['currency', 'schedules'],
                  properties: {
                    currency: {
                      type: 'string',
                      description: 'Pricing currency (ISO 4217)',
                      pattern: '^[A-Z]{3}$',
                      example: 'USD'
                    },
                    schedules: {
                      type: 'array',
                      description: 'Pricing periods with different rates',
                      items: {
                        type: 'object',
                        required: ['startDate', 'prices'],
                        properties: {
                          startDate: {
                            type: 'string',
                            format: 'date',
                            description: 'Schedule start date',
                            example: '2026-05-13'
                          },
                          endDate: {
                            type: 'string',
                            format: 'date',
                            description: 'Schedule end date (optional for ongoing)',
                            example: '2026-12-31'
                          },
                          prices: {
                            type: 'array',
                            description: 'Prices for each age group',
                            items: {
                              type: 'object',
                              required: ['ageGroup', 'retailPrice'],
                              properties: {
                                ageGroup: {
                                  type: 'string',
                                  description: 'Age group label',
                                  example: 'Adult'
                                },
                                retailPrice: {
                                  type: 'number',
                                  format: 'decimal',
                                  description: 'Price for this age group',
                                  minimum: 0,
                                  example: 35.00
                                }
                              }
                            },
                            minItems: 1
                          }
                        }
                      },
                      minItems: 1,
                      example: [
                        {
                          startDate: '2026-05-13',
                          endDate: '2026-12-31',
                          prices: [
                            { ageGroup: 'Adult', retailPrice: 35.00 },
                            { ageGroup: 'Child', retailPrice: 25.00 },
                            { ageGroup: 'Infant', retailPrice: 0.00 }
                          ]
                        }
                      ]
                    }
                  }
                }
              }
            },
            bookingAndTickets: {
              type: 'object',
              description: 'Booking policies and meeting information',
              properties: {
                instantBooking: {
                  type: 'boolean',
                  description: 'Allow instant booking without approval',
                  default: true,
                  example: true
                },
                cancellationPolicy: {
                  type: 'object',
                  description: 'Cancellation terms',
                  required: ['type', 'cutoffHours', 'refundPercentage'],
                  properties: {
                    type: {
                      type: 'string',
                      enum: ['flexible', 'moderate', 'strict'],
                      description: 'Policy type',
                      example: 'flexible'
                    },
                    cutoffHours: {
                      type: 'integer',
                      description: 'Hours before tour for free cancellation',
                      minimum: 0,
                      maximum: 168,
                      example: 24
                    },
                    refundPercentage: {
                      type: 'integer',
                      description: 'Refund percentage for timely cancellation',
                      minimum: 0,
                      maximum: 100,
                      example: 100
                    }
                  }
                },
                meetingPoint: {
                  type: 'object',
                  description: 'Where customers meet the guide',
                  required: ['name', 'address', 'instructions'],
                  properties: {
                    name: {
                      type: 'string',
                      description: 'Meeting point name',
                      example: 'Central Park Entrance'
                    },
                    address: {
                      type: 'string',
                      description: 'Full address',
                      example: 'Central Park South & 5th Avenue, New York, NY 10019'
                    },
                    coordinates: {
                      type: 'object',
                      description: 'GPS coordinates',
                      properties: {
                        lat: {
                          type: 'number',
                          format: 'double',
                          minimum: -90,
                          maximum: 90,
                          example: 40.7647
                        },
                        lng: {
                          type: 'number',
                          format: 'double',
                          minimum: -180,
                          maximum: 180,
                          example: -73.9730
                        }
                      }
                    },
                    instructions: {
                      type: 'string',
                      description: 'Detailed meeting instructions',
                      example: 'Meet your guide at the main entrance near the Plaza Hotel'
                    }
                  }
                }
              }
            },
            slug: {
              type: 'string',
              description: 'SEO-friendly URL slug (auto-generated)',
              pattern: '^[a-z0-9-]+$',
              example: 'amazing-central-park-walking-tour'
            },
            metaTitle: {
              type: 'string',
              description: 'SEO meta title',
              maxLength: 60,
              example: 'Central Park Walking Tour | Expert Local Guide',
              nullable: true
            },
            metaDescription: {
              type: 'string',
              description: 'SEO meta description',
              maxLength: 160,
              example: 'Explore Central Park with our expert guide. 2-hour walking tour covering iconic spots and hidden gems. Book now!',
              nullable: true
            },
            tags: {
              type: 'array',
              description: 'Search and categorization tags',
              items: { type: 'string' },
              maxItems: 10,
              example: ['central-park', 'walking-tour', 'nyc', 'nature', 'history']
            },
            totalBookings: {
              type: 'integer',
              description: 'Total number of bookings',
              minimum: 0,
              example: 127
            },
            totalRevenue: {
              type: 'number',
              format: 'decimal',
              description: 'Total revenue generated (USD)',
              minimum: 0,
              example: 4445.00
            },
            averageRating: {
              type: 'number',
              format: 'decimal',
              description: 'Average customer rating (1-5)',
              minimum: 1,
              maximum: 5,
              example: 4.7,
              nullable: true
            },
            reviewCount: {
              type: 'integer',
              description: 'Total number of reviews',
              minimum: 0,
              example: 89
            },
            viewCount: {
              type: 'integer',
              description: 'Total page views',
              minimum: 0,
              example: 1543
            },
            // Normalized location fields (extracted from productContent.location for indexed filtering)
            latitude: {
              type: 'number',
              format: 'double',
              description: 'GPS latitude for geo-spatial search',
              nullable: true,
              example: -33.9249
            },
            longitude: {
              type: 'number',
              format: 'double',
              description: 'GPS longitude for geo-spatial search',
              nullable: true,
              example: 18.4241
            },
            city: {
              type: 'string',
              description: 'Tour city location (indexed, extracted from productContent.location.city)',
              nullable: true,
              example: 'Cape Town'
            },
            country: {
              type: 'string',
              description: 'Tour country location (indexed, extracted from productContent.location.country)',
              nullable: true,
              example: 'South Africa'
            },
            region: {
              type: 'string',
              description: 'Tour region / state (indexed, extracted from productContent.location.region)',
              nullable: true,
              example: 'Western Cape'
            },
            // Normalized categorization fields (extracted from categorization JSON for indexed filtering)
            category: {
              type: 'string',
              description: 'Main tour category — e.g. Adventure, Cultural, Nature (indexed)',
              nullable: true,
              example: 'Adventure'
            },
            subcategory: {
              type: 'string',
              description: 'Specific tour type — e.g. Walking Tours, Hiking (indexed)',
              nullable: true,
              example: 'Safari'
            },
            activityType: {
              type: 'string',
              description: 'Activity format — e.g. Guided Tour, Self-Guided (indexed)',
              nullable: true,
              example: 'Guided Tour'
            },
            difficulty: {
              type: 'string',
              description: 'Physical difficulty — Easy, Moderate, Challenging, Expert (indexed)',
              nullable: true,
              enum: ['Easy', 'Moderate', 'Challenging', 'Expert'],
              example: 'Moderate'
            },
            primaryTheme: {
              type: 'string',
              description: 'Primary theme — e.g. Nature & Wildlife, History & Culture (indexed)',
              nullable: true,
              example: 'Nature & Wildlife'
            },
            durationMinutes: {
              type: 'integer',
              description: 'Tour duration in minutes (indexed, converted from categorization.duration.hours/days)',
              nullable: true,
              example: 180
            },
            secondaryThemes: {
              type: 'array',
              description: 'Additional themes (stored in normalized TourSecondaryTheme table)',
              items: {
                type: 'string'
              },
              example: ['Photography', 'Adventure', 'Family-Friendly']
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Tour creation timestamp',
              example: '2026-05-12T10:31:34.728Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
              example: '2026-05-12T10:31:56.017Z'
            },
            supplier: {
              type: 'object',
              description: 'Supplier information (populated)',
              properties: {
                id: { type: 'string', example: 'cmp2h5edn0000wrs1gfllik7m' },
                name: { type: 'string', example: 'Adventure Tours' },
                photoURL: { type: 'string', example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/suppliers/logo.jpg' },
                supplierProfile: {
                  type: 'object',
                  properties: {
                    averageRating: { type: 'number', example: 4.8 },
                    totalBookings: { type: 'integer', example: 342 }
                  }
                }
              }
            }
          }
        },
        TourInput: {
          type: 'object',
          description: 'Tour creation/update input',
          required: ['title', 'description', 'categorization', 'schedulesAndPricing'],
          properties: {
            title: { $ref: '#/components/schemas/Tour/properties/title' },
            description: { $ref: '#/components/schemas/Tour/properties/description' },
            categorization: { $ref: '#/components/schemas/Tour/properties/categorization' },
            theme: { $ref: '#/components/schemas/Tour/properties/theme' },
            productContent: { $ref: '#/components/schemas/Tour/properties/productContent' },
            schedulesAndPricing: { $ref: '#/components/schemas/Tour/properties/schedulesAndPricing' },
            bookingAndTickets: { $ref: '#/components/schemas/Tour/properties/bookingAndTickets' },
            tags: { $ref: '#/components/schemas/Tour/properties/tags' },
            metaTitle: { $ref: '#/components/schemas/Tour/properties/metaTitle' },
            metaDescription: { $ref: '#/components/schemas/Tour/properties/metaDescription' },
            city: { $ref: '#/components/schemas/Tour/properties/city' },
            country: { $ref: '#/components/schemas/Tour/properties/country' },
            region: { $ref: '#/components/schemas/Tour/properties/region' },
            latitude: { $ref: '#/components/schemas/Tour/properties/latitude' },
            longitude: { $ref: '#/components/schemas/Tour/properties/longitude' }
          }
        },
        // ================================
        // BOOKING SCHEMAS
        // ================================
        Booking: {
          type: 'object',
          description: 'Complete booking information with payment details',
          required: ['id', 'bookingNumber', 'customerId', 'tourId', 'status', 'travelers', 'selectedDate', 'total'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique booking identifier',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            bookingNumber: {
              type: 'string',
              description: 'Human-readable booking reference',
              pattern: '^[A-Z0-9]{8,12}$',
              example: 'EXP-2026-001'
            },
            customerId: {
              type: 'string',
              description: 'Customer user ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m'
            },
            tourId: {
              type: 'string',
              description: 'Booked tour ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'NO_SHOW'],
              description: 'Current booking status',
              example: 'CONFIRMED'
            },
            travelers: {
              type: 'object',
              description: 'Traveler information and count',
              required: ['adults'],
              properties: {
                adults: {
                  type: 'integer',
                  description: 'Number of adult travelers',
                  minimum: 1,
                  maximum: 20,
                  example: 2
                },
                children: {
                  type: 'integer',
                  description: 'Number of child travelers',
                  minimum: 0,
                  maximum: 10,
                  example: 1
                },
                infants: {
                  type: 'integer',
                  description: 'Number of infant travelers',
                  minimum: 0,
                  maximum: 5,
                  example: 0
                },
                details: {
                  type: 'array',
                  description: 'Individual traveler details',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', example: 'John Doe' },
                      age: { type: 'integer', example: 35 },
                      ageGroup: { type: 'string', example: 'Adult' },
                      specialRequests: { type: 'string', example: 'Vegetarian meal' }
                    }
                  }
                }
              },
              example: {
                adults: 2,
                children: 1,
                infants: 0,
                details: [
                  { name: 'John Doe', age: 35, ageGroup: 'Adult' },
                  { name: 'Jane Doe', age: 32, ageGroup: 'Adult' },
                  { name: 'Jimmy Doe', age: 8, ageGroup: 'Child' }
                ]
              }
            },
            selectedDate: {
              type: 'string',
              format: 'date-time',
              description: 'Selected tour date and time',
              example: '2026-05-15T10:00:00.000Z'
            },
            selectedTime: {
              type: 'string',
              description: 'Selected tour time (if applicable)',
              pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$',
              example: '10:00',
              nullable: true
            },
            subtotal: {
              type: 'number',
              format: 'decimal',
              description: 'Subtotal before taxes and fees',
              minimum: 0,
              example: 95.00
            },
            taxes: {
              type: 'number',
              format: 'decimal',
              description: 'Tax amount',
              minimum: 0,
              example: 7.60
            },
            fees: {
              type: 'number',
              format: 'decimal',
              description: 'Platform and processing fees',
              minimum: 0,
              example: 3.50
            },
            discounts: {
              type: 'number',
              format: 'decimal',
              description: 'Total discount amount',
              minimum: 0,
              example: 5.00
            },
            total: {
              type: 'number',
              format: 'decimal',
              description: 'Final total amount',
              minimum: 0,
              example: 101.10
            },
            currency: {
              type: 'string',
              description: 'Payment currency (ISO 4217)',
              pattern: '^[A-Z]{3}$',
              example: 'USD'
            },
            commissionRate: {
              type: 'number',
              format: 'decimal',
              description: 'Platform commission rate (0.15 = 15%)',
              minimum: 0,
              maximum: 1,
              example: 0.15
            },
            commissionAmount: {
              type: 'number',
              format: 'decimal',
              description: 'Platform commission amount',
              minimum: 0,
              example: 15.17
            },
            supplierPayout: {
              type: 'number',
              format: 'decimal',
              description: 'Amount paid to supplier',
              minimum: 0,
              example: 85.93
            },
            stripePaymentIntentId: {
              type: 'string',
              description: 'Stripe Payment Intent ID',
              pattern: '^pi_[a-zA-Z0-9]+$',
              example: 'pi_1234567890abcdef',
              nullable: true
            },
            paymentStatus: {
              type: 'string',
              enum: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED'],
              description: 'Payment processing status',
              example: 'SUCCEEDED'
            },
            paidAt: {
              type: 'string',
              format: 'date-time',
              description: 'Payment completion timestamp',
              example: '2026-05-12T10:35:22.123Z',
              nullable: true
            },
            cancellationReason: {
              type: 'string',
              description: 'Reason for cancellation',
              maxLength: 500,
              example: 'Customer requested cancellation due to weather concerns',
              nullable: true
            },
            cancelledAt: {
              type: 'string',
              format: 'date-time',
              description: 'Cancellation timestamp',
              example: '2026-05-12T10:40:15.456Z',
              nullable: true
            },
            refundAmount: {
              type: 'number',
              format: 'decimal',
              description: 'Refund amount processed',
              minimum: 0,
              example: 95.00,
              nullable: true
            },
            refundedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Refund processing timestamp',
              example: '2026-05-12T10:45:30.789Z',
              nullable: true
            },
            specialRequests: {
              type: 'string',
              description: 'Customer special requests',
              maxLength: 1000,
              example: 'Please accommodate wheelchair accessibility',
              nullable: true
            },
            supplierNotes: {
              type: 'string',
              description: 'Supplier notes about the booking',
              maxLength: 1000,
              example: 'Customer confirmed pickup location via phone',
              nullable: true
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Booking creation timestamp',
              example: '2026-05-12T10:30:00.000Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
              example: '2026-05-12T10:35:22.123Z'
            },
            customer: {
              type: 'object',
              description: 'Customer information (populated)',
              properties: {
                id: { type: 'string', example: 'cmp2h5edn0000wrs1gfllik7m' },
                name: { type: 'string', example: 'John Doe' },
                email: { type: 'string', example: 'john.doe@example.com' },
                phone: { type: 'string', example: '+1234567890' }
              }
            },
            tour: {
              type: 'object',
              description: 'Tour information (populated)',
              properties: {
                id: { type: 'string', example: 'cmp2hql3c0001tzv0460pbckm' },
                title: { type: 'string', example: 'Amazing Central Park Walking Tour' },
                slug: { type: 'string', example: 'amazing-central-park-walking-tour' },
                photos: { type: 'array', items: { type: 'string' } }
              }
            }
          }
        },
        BookingInput: {
          type: 'object',
          description: 'Booking creation input',
          properties: {
            tourId: {
              type: 'string',
              description: 'Tour ID (required for direct booking)',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            selectedDate: {
              type: 'string',
              format: 'date',
              description: 'Selected tour date (required for direct booking)',
              example: '2026-05-15'
            },
            selectedTime: {
              type: 'string',
              description: 'Selected tour time (optional)',
              pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$',
              example: '10:00'
            },
            travelers: {
              $ref: '#/components/schemas/Booking/properties/travelers'
            },
            specialRequests: {
              type: 'string',
              maxLength: 1000,
              example: 'Please accommodate wheelchair accessibility'
            },
            paymentMethodId: {
              type: 'string',
              description: 'Stripe payment method ID',
              pattern: '^pm_[a-zA-Z0-9]+$',
              example: 'pm_1234567890abcdef'
            },
            useCart: {
              type: 'boolean',
              description: 'Book all items in cart instead of direct booking',
              default: false,
              example: false
            }
          },
          required: ['paymentMethodId']
        },
        CartItem: {
          type: 'object',
          description: 'Shopping cart item',
          required: ['id', 'customerId', 'tourId', 'selectedDate', 'travelers', 'total'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique cart item identifier',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            customerId: {
              type: 'string',
              description: 'Customer user ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m'
            },
            tourId: {
              type: 'string',
              description: 'Tour ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            selectedDate: {
              type: 'string',
              format: 'date-time',
              description: 'Selected tour date',
              example: '2026-05-15T10:00:00.000Z'
            },
            selectedTime: {
              type: 'string',
              description: 'Selected tour time',
              pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$',
              example: '10:00',
              nullable: true
            },
            travelers: {
              $ref: '#/components/schemas/Booking/properties/travelers'
            },
            subtotal: {
              type: 'number',
              format: 'decimal',
              description: 'Item subtotal',
              minimum: 0,
              example: 95.00
            },
            total: {
              type: 'number',
              format: 'decimal',
              description: 'Item total with taxes/fees',
              minimum: 0,
              example: 101.10
            },
            currency: {
              type: 'string',
              pattern: '^[A-Z]{3}$',
              example: 'USD'
            },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'Cart item expiration time',
              example: '2026-05-12T12:30:00.000Z'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              example: '2026-05-12T10:30:00.000Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              example: '2026-05-12T10:30:00.000Z'
            },
            tour: {
              type: 'object',
              description: 'Tour information (populated)',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                photos: { type: 'array', items: { type: 'string' } },
                supplier: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' }
                  }
                }
              }
            }
          }
        },
        CartItemInput: {
          type: 'object',
          description: 'Add to cart input',
          required: ['tourId', 'selectedDate', 'travelers'],
          properties: {
            tourId: {
              type: 'string',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            selectedDate: {
              type: 'string',
              format: 'date',
              example: '2026-05-15'
            },
            selectedTime: {
              type: 'string',
              pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$',
              example: '10:00'
            },
            travelers: {
              type: 'object',
              required: ['adults'],
              properties: {
                adults: { type: 'integer', minimum: 1, example: 2 },
                children: { type: 'integer', minimum: 0, example: 1 },
                infants: { type: 'integer', minimum: 0, example: 0 }
              }
            }
          }
        },
        // ================================
        // REVIEW SCHEMAS
        // ================================
        Review: {
          type: 'object',
          description: 'Customer review with supplier response capability',
          required: ['id', 'bookingId', 'customerId', 'tourId', 'rating'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique review identifier',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            bookingId: {
              type: 'string',
              description: 'Associated booking ID (one review per booking)',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            customerId: {
              type: 'string',
              description: 'Reviewer user ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m'
            },
            tourId: {
              type: 'string',
              description: 'Reviewed tour ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            rating: {
              type: 'integer',
              description: 'Star rating (1-5 scale)',
              minimum: 1,
              maximum: 5,
              example: 5
            },
            title: {
              type: 'string',
              description: 'Review title/headline',
              maxLength: 200,
              example: 'Amazing experience in Central Park!',
              nullable: true
            },
            comment: {
              type: 'string',
              description: 'Detailed review comment',
              maxLength: 2000,
              example: 'Our guide was incredibly knowledgeable and showed us parts of Central Park we never would have found on our own. The tour was well-paced and perfect for our family with young children.',
              nullable: true
            },
            photos: {
              type: 'array',
              description: 'Review photos (Cloudinary URLs)',
              items: {
                type: 'string',
                format: 'uri'
              },
              maxItems: 10,
              example: [
                'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/reviews/photo1.jpg',
                'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/reviews/photo2.jpg'
              ]
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'APPROVED', 'REJECTED', 'FLAGGED'],
              description: 'Moderation status',
              default: 'PENDING',
              example: 'APPROVED'
            },
            moderatedBy: {
              type: 'string',
              description: 'Admin user ID who moderated',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m',
              nullable: true
            },
            moderatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Moderation timestamp',
              example: '2026-05-12T11:00:00.000Z',
              nullable: true
            },
            flagReason: {
              type: 'string',
              description: 'Reason for flagging (if flagged)',
              maxLength: 500,
              example: 'Inappropriate language',
              nullable: true
            },
            supplierResponse: {
              type: 'string',
              description: 'Supplier response to review',
              maxLength: 1000,
              example: 'Thank you for the wonderful review! We are delighted you enjoyed exploring Central Park with us. We look forward to welcoming you back for another adventure!',
              nullable: true
            },
            supplierResponseAt: {
              type: 'string',
              format: 'date-time',
              description: 'Supplier response timestamp',
              example: '2026-05-12T12:00:00.000Z',
              nullable: true
            },
            verified: {
              type: 'boolean',
              description: 'Whether the reviewer has a verified booking for this tour',
              example: true
            },
            helpfulCount: {
              type: 'integer',
              description: 'Number of helpful votes',
              minimum: 0,
              example: 12
            },
            reportCount: {
              type: 'integer',
              description: 'Number of reports/flags',
              minimum: 0,
              example: 0
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Review creation timestamp',
              example: '2026-05-12T10:45:00.000Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
              example: '2026-05-12T12:00:00.000Z'
            },
            customer: {
              type: 'object',
              description: 'Customer information (populated)',
              properties: {
                id: { type: 'string', example: 'cmp2h5edn0000wrs1gfllik7m' },
                name: { type: 'string', example: 'John Doe' },
                photoURL: { type: 'string', example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/users/profile.jpg' }
              }
            },
            tour: {
              type: 'object',
              description: 'Tour information (populated)',
              properties: {
                id: { type: 'string', example: 'cmp2hql3c0001tzv0460pbckm' },
                title: { type: 'string', example: 'Amazing Central Park Walking Tour' },
                slug: { type: 'string', example: 'amazing-central-park-walking-tour' }
              }
            },
            booking: {
              type: 'object',
              description: 'Booking information (populated)',
              properties: {
                id: { type: 'string', example: 'cmp2hql3c0001tzv0460pbckm' },
                bookingNumber: { type: 'string', example: 'EXP-2026-001' },
                selectedDate: { type: 'string', format: 'date-time', example: '2026-05-15T10:00:00.000Z' }
              }
            }
          }
        },
        ReviewInput: {
          type: 'object',
          description: 'Review creation input',
          required: ['bookingId', 'rating'],
          properties: {
            bookingId: {
              type: 'string',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            rating: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              example: 5
            },
            title: {
              type: 'string',
              maxLength: 200,
              example: 'Amazing experience in Central Park!'
            },
            comment: {
              type: 'string',
              maxLength: 2000,
              example: 'Our guide was incredibly knowledgeable and showed us parts of Central Park we never would have found on our own.'
            }
          }
        },
        SupplierResponse: {
          type: 'object',
          description: 'Supplier response to review',
          required: ['response'],
          properties: {
            response: {
              type: 'string',
              description: 'Supplier response text',
              minLength: 10,
              maxLength: 1000,
              example: 'Thank you for the wonderful review! We are delighted you enjoyed exploring Central Park with us.'
            }
          }
        },
        ReviewModeration: {
          type: 'object',
          description: 'Admin review moderation',
          required: ['action'],
          properties: {
            action: {
              type: 'string',
              enum: ['approve', 'reject', 'flag'],
              description: 'Moderation action to take',
              example: 'approve'
            },
            reason: {
              type: 'string',
              description: 'Reason for rejection or flagging',
              maxLength: 500,
              example: 'Contains inappropriate language'
            }
          }
        },

        // ================================
        // NOTIFICATION SCHEMAS
        // ================================
        Notification: {
          type: 'object',
          description: 'Real-time notification',
          required: ['id', 'userId', 'type', 'title', 'message'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique notification identifier',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2hql3c0001tzv0460pbckm'
            },
            userId: {
              type: 'string',
              description: 'Recipient user ID',
              pattern: '^c[a-z0-9]{24}$',
              example: 'cmp2h5edn0000wrs1gfllik7m'
            },
            type: {
              type: 'string',
              enum: [
                'BOOKING_CONFIRMED',
                'BOOKING_CANCELLED',
                'PAYMENT_RECEIVED',
                'REVIEW_RECEIVED',
                'SUPPLIER_APPROVED',
                'SUPPLIER_REJECTED',
                'PAYOUT_PROCESSED',
                'SYSTEM_ALERT'
              ],
              description: 'Notification type for categorization',
              example: 'BOOKING_CONFIRMED'
            },
            title: {
              type: 'string',
              description: 'Notification title',
              maxLength: 200,
              example: 'Booking Confirmed!'
            },
            message: {
              type: 'string',
              description: 'Notification message',
              maxLength: 1000,
              example: 'Your booking for Amazing Central Park Walking Tour has been confirmed for May 15, 2026.'
            },
            data: {
              type: 'object',
              description: 'Additional structured data',
              properties: {
                bookingId: { type: 'string', example: 'cmp2hql3c0001tzv0460pbckm' },
                tourId: { type: 'string', example: 'cmp2hql3c0001tzv0460pbckm' },
                amount: { type: 'number', example: 101.10 },
                actionUrl: { type: 'string', example: '/bookings/cmp2hql3c0001tzv0460pbckm' }
              },
              nullable: true
            },
            read: {
              type: 'boolean',
              description: 'Read status',
              default: false,
              example: false
            },
            readAt: {
              type: 'string',
              format: 'date-time',
              description: 'Read timestamp',
              example: '2026-05-12T11:00:00.000Z',
              nullable: true
            },
            emailSent: {
              type: 'boolean',
              description: 'Email notification sent',
              default: false,
              example: true
            },
            emailSentAt: {
              type: 'string',
              format: 'date-time',
              description: 'Email sent timestamp',
              example: '2026-05-12T10:31:00.000Z',
              nullable: true
            },
            pushSent: {
              type: 'boolean',
              description: 'Push notification sent',
              default: false,
              example: false
            },
            pushSentAt: {
              type: 'string',
              format: 'date-time',
              description: 'Push notification timestamp',
              example: '2026-05-12T10:31:00.000Z',
              nullable: true
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Notification creation timestamp',
              example: '2026-05-12T10:30:00.000Z'
            }
          }
        },

        // ================================
        // COMMON SCHEMAS
        // ================================
        Pagination: {
          type: 'object',
          description: 'Pagination metadata',
          properties: {
            currentPage: {
              type: 'integer',
              description: 'Current page number',
              minimum: 1,
              example: 1
            },
            totalPages: {
              type: 'integer',
              description: 'Total number of pages',
              minimum: 0,
              example: 5
            },
            totalCount: {
              type: 'integer',
              description: 'Total number of items',
              minimum: 0,
              example: 50
            },
            hasNextPage: {
              type: 'boolean',
              description: 'Has next page',
              example: true
            },
            hasPrevPage: {
              type: 'boolean',
              description: 'Has previous page',
              example: false
            },
            limit: {
              type: 'integer',
              description: 'Items per page',
              minimum: 1,
              example: 10
            }
          }
        },
        SuccessResponse: {
          type: 'object',
          description: 'Standard success response',
          properties: {
            status: {
              type: 'string',
              enum: ['success'],
              example: 'success'
            },
            message: {
              type: 'string',
              description: 'Success message',
              example: 'Operation completed successfully'
            },
            data: {
              type: 'object',
              description: 'Response data'
            }
          }
        },
        ErrorResponse: {
          type: 'object',
          description: 'Standard error response',
          properties: {
            status: {
              type: 'string',
              enum: ['fail', 'error'],
              example: 'fail'
            },
            message: {
              type: 'string',
              description: 'Error message',
              example: 'Validation failed'
            },
            error: {
              type: 'object',
              properties: {
                statusCode: {
                  type: 'integer',
                  example: 400
                },
                status: {
                  type: 'string',
                  example: 'fail'
                },
                isOperational: {
                  type: 'boolean',
                  example: true
                }
              }
            },
            stack: {
              type: 'string',
              description: 'Error stack trace (development only)',
              example: 'Error: Validation failed\\n    at ...'
            }
          }
        },
        FileUpload: {
          type: 'object',
          description: 'File upload response',
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              description: 'Cloudinary file URL',
              example: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/uploads/file.jpg'
            },
            publicId: {
              type: 'string',
              description: 'Cloudinary public ID',
              example: 'uploads/file'
            },
            format: {
              type: 'string',
              description: 'File format',
              example: 'jpg'
            },
            size: {
              type: 'integer',
              description: 'File size in bytes',
              example: 1024000
            }
          }
        }
      },
      responses: {
        UnauthorizedError: {
          description: 'Authentication required - Invalid or missing JWT token',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
              example: {
                status: 'fail',
                message: 'You are not logged in! Please log in to get access.',
                error: {
                  statusCode: 401,
                  status: 'fail',
                  isOperational: true
                }
              }
            }
          }
        },
        ForbiddenError: {
          description: 'Insufficient permissions - User lacks required role',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
              example: {
                status: 'fail',
                message: 'You do not have permission to perform this action',
                error: {
                  statusCode: 403,
                  status: 'fail',
                  isOperational: true
                }
              }
            }
          }
        },
        NotFoundError: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
              example: {
                status: 'fail',
                message: 'Resource not found',
                error: {
                  statusCode: 404,
                  status: 'fail',
                  isOperational: true
                }
              }
            }
          }
        },
        ValidationError: {
          description: 'Validation error - Invalid input data',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
              example: {
                status: 'fail',
                message: 'Validation failed: Title is required, Description must be at least 50 characters',
                error: {
                  statusCode: 400,
                  status: 'fail',
                  isOperational: true
                }
              }
            }
          }
        },
        RateLimitError: {
          description: 'Rate limit exceeded',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
              example: {
                status: 'fail',
                message: 'Too many requests from this IP, please try again later.',
                error: {
                  statusCode: 429,
                  status: 'fail',
                  isOperational: true
                }
              }
            }
          }
        },
        ServerError: {
          description: 'Internal server error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
              example: {
                status: 'error',
                message: 'Something went wrong on our end. Please try again later.',
                error: {
                  statusCode: 500,
                  status: 'error',
                  isOperational: false
                }
              }
            }
          }
        }
      },
      examples: {
        UserExample: {
          summary: 'Complete user profile',
          value: {
            id: 'cmp2h5edn0000wrs1gfllik7m',
            firebaseUid: 'firebase-uid-123',
            name: 'John Doe',
            email: 'john.doe@example.com',
            photoURL: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/users/profile.jpg',
            phone: '+1234567890',
            roles: ['customer', 'supplier'],
            stripeCustomerId: 'cus_1234567890abcdef',
            wishlist: ['cmp2hql3c0001tzv0460pbckm'],
            likes: ['cmp2hql3c0001tzv0460pbckm'],
            language: 'en',
            timezone: 'America/New_York',
            active: true,
            emailVerified: true,
            lastLoginAt: '2026-05-12T10:15:06.251Z',
            createdAt: '2026-05-12T10:15:06.251Z',
            updatedAt: '2026-05-12T10:25:23.937Z'
          }
        },
        TourExample: {
          summary: 'Complete tour with all details',
          value: {
            id: 'cmp2hql3c0001tzv0460pbckm',
            supplierId: 'cmp2h5edn0000wrs1gfllik7m',
            title: 'Amazing Central Park Walking Tour',
            description: 'Discover the hidden gems of Central Park with our expert local guide.',
            photos: [
              'https://res.cloudinary.com/dfpagrtoy/image/upload/v1234567890/tours/central-park-1.jpg'
            ],
            status: 'ACTIVE',
            categorization: {
              category: 'Cultural',
              subcategory: 'Walking Tours',
              difficulty: 'Easy',
              duration: 120
            },
            schedulesAndPricing: {
              travelerDetails: {
                pricingModel: 'perPerson',
                maxTravelersPerBooking: 15,
                ageGroups: [
                  { label: 'Adult', minAge: 13, maxAge: 99 },
                  { label: 'Child', minAge: 6, maxAge: 12 },
                  { label: 'Infant', minAge: 0, maxAge: 5 }
                ]
              },
              pricingSchedules: {
                currency: 'USD',
                schedules: [
                  {
                    startDate: '2026-05-13',
                    endDate: '2026-12-31',
                    prices: [
                      { ageGroup: 'Adult', retailPrice: 35.00 },
                      { ageGroup: 'Child', retailPrice: 25.00 },
                      { ageGroup: 'Infant', retailPrice: 0.00 }
                    ]
                  }
                ]
              }
            },
            slug: 'amazing-central-park-walking-tour',
            tags: ['central-park', 'walking-tour', 'nyc'],
            totalBookings: 127,
            totalRevenue: 4445.00,
            averageRating: 4.7,
            reviewCount: 89,
            viewCount: 1543,
            createdAt: '2026-05-12T10:31:34.728Z',
            updatedAt: '2026-05-12T10:31:56.017Z'
          }
        }
      }
    },
    // ================================
    // ANALYTICS SCHEMAS
    // ================================
    Event: {
      type: 'object',
      description: 'Product analytics event for user behaviour tracking and funnel analysis',
      properties: {
        id: { type: 'string', description: 'Unique event identifier', example: 'cmp6z1vnu0009v7rabyjmnst5' },
        name: { type: 'string', description: 'Dot-notation event name. e.g. "booking.completed", "tour.viewed", "search.executed"', example: 'booking.completed' },
        userId: { type: 'string', description: 'Authenticated user who triggered the event', nullable: true, example: 'cmp2h5edn0000wrs1gfllik7m' },
        sessionId: { type: 'string', description: 'Anonymous session fingerprint for unauthenticated tracking', nullable: true, example: 'a1b2c3d4e5f6...' },
        resource: { type: 'string', description: 'Affected entity type', nullable: true, example: 'Booking' },
        resourceId: { type: 'string', description: 'Affected entity primary key', nullable: true, example: 'cmp2hql3c0001tzv0460pbckm' },
        properties: { type: 'object', description: 'Arbitrary event payload (JSON)', example: { total: 150, currency: 'USD', tourId: 'cmp2hql3c0001tzv0460pbckm' } },
        source: { type: 'string', description: 'Origin of the event', enum: ['web', 'mobile', 'api', 'webhook', 'system'], example: 'webhook' },
        createdAt: { type: 'string', format: 'date-time', description: 'Event timestamp' }
      }
    },
    AnalyticsOverview: {
      type: 'object',
      description: 'Platform-wide analytics snapshot response',
      properties: {
        overview: {
          type: 'object',
          properties: {
            revenue: {
              type: 'object',
              properties: {
                today: { type: 'object', properties: { revenue: { type: 'string' }, supplierPayout: { type: 'string' }, commission: { type: 'string' } } },
                thisWeek: { type: 'object', properties: { revenue: { type: 'string' }, supplierPayout: { type: 'string' }, commission: { type: 'string' } } },
                thisMonth: { type: 'object', properties: { revenue: { type: 'string' }, supplierPayout: { type: 'string' }, commission: { type: 'string' } } },
                ytd: { type: 'object', properties: { revenue: { type: 'string' }, supplierPayout: { type: 'string' }, commission: { type: 'string' } } }
              }
            },
            bookings: {
              type: 'object',
              properties: {
                today: { type: 'integer' }, thisWeek: { type: 'integer' },
                thisMonth: { type: 'integer' }, ytd: { type: 'integer' }
              }
            },
            signups: {
              type: 'object',
              properties: {
                today: { type: 'integer' }, thisWeek: { type: 'integer' },
                thisMonth: { type: 'integer' }, ytd: { type: 'integer' }
              }
            },
            activeUsersLast30Days: { type: 'integer' }
          }
        },
        topTours: { type: 'array', items: { type: 'object' } },
        topSuppliers: { type: 'array', items: { type: 'object' } },
        bookingStatusDistribution: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, count: { type: 'integer' } } } },
        eventFeed: { type: 'array', items: { '$ref': '#/components/schemas/Event' } },
        totalEvents: { type: 'integer' }
      }
    },
    FunnelStep: {
      type: 'object',
      properties: {
        step: { type: 'string', enum: ['viewed', 'cart_added', 'checkout_started', 'booking_completed'], description: 'Funnel stage name' },
        users: { type: 'integer', description: 'Unique users who reached this stage' },
        dropOff: { type: 'string', nullable: true, description: 'Drop-off percentage from previous stage (null for first stage)', example: '25.0%' }
      }
    },
    FunnelResponse: {
      type: 'object',
      description: 'Booking conversion funnel data',
      properties: {
        period: { type: 'string', example: '30d' },
        funnel: { type: 'array', items: { '$ref': '#/components/schemas/FunnelStep' } },
        conversionRates: {
          type: 'object',
          properties: {
            viewToCart: { type: 'number', example: 60.0 },
            cartToCheckout: { type: 'number', example: 75.0 },
            checkoutToComplete: { type: 'number', example: 100.0 },
            overall: { type: 'number', example: 60.0 }
          }
        },
        dailyTrend: { type: 'array', items: { type: 'object' } }
      }
    },
    CLVResponse: {
      type: 'object',
      description: 'Customer Lifetime Value & repeat booking analysis',
      properties: {
        overview: {
          type: 'object',
          properties: {
            totalCustomers: { type: 'integer' },
            totalBookings: { type: 'integer' },
            avgBookingValue: { type: 'string' },
            totalRevenue: { type: 'string' },
            avgCLV: { type: 'number' }
          }
        },
        repeatRate: {
          type: 'object',
          properties: {
            totalCustomers: { type: 'integer' },
            repeatCustomers: { type: 'integer' },
            repeatRate: { type: 'number', description: 'Percentage of customers with 2+ bookings' },
            avgBookingsPerCustomer: { type: 'number' }
          }
        },
        distribution: {
          type: 'array',
          description: 'Customer distribution by number of bookings',
          items: {
            type: 'object',
            properties: {
              bookingCount: { type: 'string', example: '1' },
              customers: { type: 'integer' },
              percentage: { type: 'number' }
            }
          }
        },
        topCustomers: {
          type: 'array',
          description: 'Top 20 customers by lifetime value',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' },
              totalBookings: { type: 'integer' }, totalSpent: { type: 'number' },
              avgBookingValue: { type: 'number' }, lastBookingDate: { type: 'string', format: 'date-time' }
            }
          }
        },
        cohorts: {
          type: 'array',
          description: 'Monthly signup cohort performance (YTD)',
          items: {
            type: 'object',
            properties: {
              month: { type: 'string', format: 'date' }, users: { type: 'integer' },
              bookings: { type: 'integer' }, revenue: { type: 'number' },
              bookingsPerUser: { type: 'number' }, revenuePerUser: { type: 'number' }
            }
          }
        }
      }
    },
    SearchAnalyticsResponse: {
      type: 'object',
      description: 'Search query analytics and zero-result discovery',
      properties: {
        period: { type: 'string', example: '30d' },
        overview: {
          type: 'object',
          properties: {
            totalSearches: { type: 'integer' },
            uniqueSearchers: { type: 'integer' },
            zeroResultSearches: { type: 'integer', description: 'Searches with zero results — indicates unmet demand' },
            zeroResultRate: { type: 'number' }
          }
        },
        searchOutcome: {
          type: 'object',
          properties: {
            searchers: { type: 'integer' },
            viewersAfterSearch: { type: 'integer' },
            bookersAfterSearch: { type: 'integer' },
            searchToViewRate: { type: 'number' },
            searchToBookRate: { type: 'number' }
          }
        },
        topQueries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              query: { type: 'string' }, searches: { type: 'integer' },
              uniqueUsers: { type: 'integer' }, avgResults: { type: 'number' }
            }
          }
        },
        zeroResultQueries: {
          type: 'array',
          description: 'Product opportunity: queries with demand but no matching tours',
          items: {
            type: 'object',
            properties: { query: { type: 'string' }, searches: { type: 'integer' }, uniqueUsers: { type: 'integer' } }
          }
        },
        dailyTrend: { type: 'array', items: { type: 'object' } }
      }
    },
    CartAbandonmentResponse: {
      type: 'object',
      description: 'Cart abandonment rate and per-tour breakdown',
      properties: {
        period: { type: 'string', example: '30d' },
        overview: {
          type: 'object',
          properties: {
            cartsCreated: { type: 'integer' },
            cartsConverted: { type: 'integer' },
            abandonmentRate: { type: 'number', description: 'Percentage of carts that never converted to bookings' }
          }
        },
        byTour: {
          type: 'array',
          description: 'Breakdown by individual tour',
          items: {
            type: 'object',
            properties: {
              tourId: { type: 'string' }, tourTitle: { type: 'string' },
              cartsAdded: { type: 'integer' }, converted: { type: 'integer' },
              abandonmentRate: { type: 'number' }
            }
          }
        },
        dailyTrend: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              day: { type: 'string', format: 'date' }, cartsAdded: { type: 'integer' },
              converted: { type: 'integer' }, abandonmentRate: { type: 'number' }
            }
          }
        }
      }
    },
    RevenueTrendResponse: {
      type: 'object',
      description: 'Monthly revenue breakdown for charting',
      properties: {
        months: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              month: { type: 'string', format: 'date' }, bookings: { type: 'integer' },
              revenue: { type: 'number' }, commission: { type: 'number' },
              supplierPayout: { type: 'number' }
            }
          }
        }
      }
    },
    UserGrowthResponse: {
      type: 'object',
      description: 'Monthly signup growth by role',
      properties: {
        growth: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              month: { type: 'string', format: 'date' }, total: { type: 'integer' },
              customers: { type: 'integer' }, suppliers: { type: 'integer' }
            }
          }
        }
      }
    },
    TourPerformanceResponse: {
      type: 'object',
      description: 'Paginated tour-level performance metrics for admin',
      allOf: [
        { '$ref': '#/components/schemas/PaginatedResponse' },
        {
          type: 'object',
          properties: {
            tours: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, title: { type: 'string' }, slug: { type: 'string' },
                  status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] },
                  totalBookings: { type: 'integer' }, totalRevenue: { type: 'number' },
                  averageRating: { type: 'number' }, reviewCount: { type: 'integer' },
                  viewCount: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' },
                  supplier: {
                    type: 'object',
                    properties: { id: { type: 'string' }, name: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      ]
    },
    PaginatedResponse: {
      type: 'object',
      description: 'Generic pagination metadata',
      properties: {
        pagination: {
          type: 'object',
          properties: {
            currentPage: { type: 'integer' }, totalPages: { type: 'integer' },
            totalCount: { type: 'integer' }, limit: { type: 'integer' }
          }
        }
      }
    },
    PayoutMethod: {
      type: 'object',
      description: 'Supplier payout method (bank, mobile money, or PayPal)',
      properties: {
        id: { type: 'string' },
        supplierId: { type: 'string' },
        type: { type: 'string', enum: ['BANK_TRANSFER', 'MOBILE_MONEY', 'PAYPAL'] },
        isDefault: { type: 'boolean' },
        currency: { type: 'string', example: 'USD' },
        bankName: { type: 'string' },
        bankAddress: { type: 'string' },
        bankCountry: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. GH, NG, US' },
        accountName: { type: 'string' },
        accountNumber: { type: 'string' },
        routingNumber: { type: 'string', description: 'ABA routing number (US)' },
        swiftCode: { type: 'string', description: 'SWIFT/BIC code (international)' },
        iban: { type: 'string' },
        sortCode: { type: 'string', description: 'Sort code (UK, Ghana, etc.)' },
        branchCode: { type: 'string', description: 'Branch/bank code (Nigeria, etc.)' },
        mobileProvider: { type: 'string', example: 'MTN' },
        mobileNumber: { type: 'string' },
        paypalEmail: { type: 'string', format: 'email' },
        verified: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' }
      }
    },
    Payout: {
      type: 'object',
      description: 'Supplier payout record for a confirmed booking',
      properties: {
        id: { type: 'string', description: 'Payout ID' },
        supplierId: { type: 'string', description: 'Supplier user ID' },
        bookingId: { type: 'string', description: 'Associated booking ID' },
        amount: { type: 'number', description: 'Payout amount', example: 85.00 },
        currency: { type: 'string', example: 'USD' },
        commissionAmount: { type: 'number', description: 'Platform commission', example: 15.00 },
        status: {
          type: 'string',
          enum: ['PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED']
        },
        payoutMethodId: { type: 'string', description: 'Linked payout method ID', nullable: true },
        payoutMethod: {
          type: 'object',
          description: 'Payout method used for this release (populated)',
          nullable: true,
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['BANK_TRANSFER', 'MOBILE_MONEY', 'PAYPAL'] },
            verified: { type: 'boolean' },
            bankName: { type: 'string' },
            accountName: { type: 'string' },
            accountNumber: { type: 'string' },
            mobileProvider: { type: 'string' },
            mobileNumber: { type: 'string' },
            paypalEmail: { type: 'string' }
          }
        },
        approvedAt: { type: 'string', format: 'date-time' },
        approvedBy: { type: 'string', description: 'Admin who approved' },
        processedAt: { type: 'string', format: 'date-time' },
        processedBy: { type: 'string', description: 'Admin who processed' },
        paidAt: { type: 'string', format: 'date-time' },
        paymentMethod: { type: 'string', example: 'BANK_TRANSFER' },
        reference: { type: 'string', description: 'Transaction reference' },
        notes: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' }
      }
    },
    PayoutMethodInput: {
      type: 'object',
      description: 'Add/update a payout method',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['BANK_TRANSFER', 'MOBILE_MONEY', 'PAYPAL'], description: 'Payout method type' },
        isDefault: { type: 'boolean', description: 'Set as default method' },
        currency: { type: 'string', example: 'USD' },
        bankName: { type: 'string', description: 'Bank name (required for BANK_TRANSFER)' },
        bankAddress: { type: 'string' },
        bankCountry: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. GH (required for BANK_TRANSFER)' },
        accountName: { type: 'string', description: 'Account holder name (required for BANK_TRANSFER)' },
        accountNumber: { type: 'string', description: 'Account number (required if no IBAN)' },
        sortCode: { type: 'string', description: 'Sort code (UK, Ghana, etc.)' },
        branchCode: { type: 'string', description: 'Branch/bank code (Nigeria, etc.)' },
        routingNumber: { type: 'string', description: 'Routing/ABA number (US)' },
        swiftCode: { type: 'string', description: 'SWIFT/BIC code (international)' },
        iban: { type: 'string', description: 'IBAN (required if no account number)' },
        mobileProvider: { type: 'string', description: 'Provider name e.g. MTN, Orange (required for MOBILE_MONEY)' },
        mobileNumber: { type: 'string', description: 'Mobile money number (required for MOBILE_MONEY)' },
        paypalEmail: { type: 'string', format: 'email', description: 'PayPal email (required for PAYPAL)' }
      }
    },
    PayoutReleaseInput: {
      type: 'object',
      description: 'Release a payout — confirms payment was sent',
      properties: {
        payoutMethodId: { type: 'string', description: 'Specific payout method to use (defaults to default verified method)' },
        reference: { type: 'string', description: 'Transaction ID or receipt from bank/MoMo/PayPal' },
        notes: { type: 'string', description: 'Admin notes' }
      }
    },
    PayoutFailInput: {
      type: 'object',
      description: 'Mark a payout as failed',
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: 'Reason for failure' }
      }
    },
    PayoutApproveResponse: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'success' },
        data: {
          type: 'object',
          properties: {
            payout: { $ref: '#/components/schemas/Payout' }
          }
        }
      }
    },
    security: [
      {
        bearerAuth: []
      }
    ]
  },
  apis: [
    path.join(__dirname, '../routes/*.js'),
    path.join(__dirname, '../controllers/*.js')
  ]
};

module.exports = swaggerJSDoc(options);