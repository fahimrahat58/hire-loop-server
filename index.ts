import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import { ObjectId, type Collection, type Document } from "mongodb";

import { connectDB } from "./config/db.js";
import {
  verifyUser,
  verifySeeker,
  verifyRecruiter,
  verifyAdmin,
  type AuthRequest,
} from "./middleware/auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const FREE_APPLICATION_LIMIT = 5;
const FREE_PUBLISHED_JOB_LIMIT = 5;

// ====================================
// STRIPE
// ====================================

const getStripe = () => {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is missing");
  }

  return new Stripe(secretKey);
};

type HireLoopPlanId = "seeker_premium" | "recruiter_premium";

const PLAN_DEFINITIONS: Record<
  HireLoopPlanId,
  { role: "seeker" | "recruiter"; planName: string }
> = {
  seeker_premium: {
    role: "seeker",
    planName: "Seeker Premium",
  },
  recruiter_premium: {
    role: "recruiter",
    planName: "Recruiter Premium",
  },
};

const getPlanDefinition = (planId: string | null | undefined) => {
  if (!planId) return null;

  return PLAN_DEFINITIONS[planId as HireLoopPlanId] || null;
};

const getConfiguredPriceId = (planId: HireLoopPlanId) => {
  if (planId === "seeker_premium") {
    return process.env.STRIPE_SEEKER_PRICE_ID;
  }

  return process.env.STRIPE_RECRUITER_PRICE_ID;
};

const getPlanIdForRole = (role: "seeker" | "recruiter"): HireLoopPlanId =>
  role === "seeker" ? "seeker_premium" : "recruiter_premium";

const resolvePlanFromPriceId = (
  priceId: string | null | undefined,
): HireLoopPlanId | null => {
  if (!priceId) return null;

  const seekerPriceId = process.env.STRIPE_SEEKER_PRICE_ID;
  const recruiterPriceId = process.env.STRIPE_RECRUITER_PRICE_ID;

  if (seekerPriceId && priceId === seekerPriceId) {
    return "seeker_premium";
  }

  if (recruiterPriceId && priceId === recruiterPriceId) {
    return "recruiter_premium";
  }

  return null;
};

const getStripeObjectId = (value: unknown): string | null => {
  if (typeof value === "string") return value;

  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }

  return null;
};

// ====================================
// CORS
// ====================================

const normalizeOrigin = (value?: string) => {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const configuredOrigins = [
  "http://localhost:3000",
  ...(process.env.FRONTEND_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  process.env.AUTH_BASE_URL,
];

const allowedOrigins = Array.from(
  new Set(
    configuredOrigins
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin)),
  ),
);

// Production and legitimate preview deployments for this specific Vercel project.
const allowedVercelOriginPatterns = [
  /^https:\/\/hire-loop-client-programming-hero11\.vercel\.app$/i,
  /^https:\/\/hire-loop-client-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-programming-hero11\.vercel\.app$/i,
];

const isAllowedOrigin = (origin?: string) => {
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);

  if (!normalized) return false;

  if (allowedOrigins.includes(normalized)) {
    return true;
  }

  return allowedVercelOriginPatterns.some((pattern) =>
    pattern.test(normalized),
  );
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      console.error("SERVER ERROR: CORS blocked for origin:", origin);

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-user-id",
      "x-user-email",
      "x-user-role",
    ],
  }),
);

// ====================================
// DATABASE COLLECTIONS
// ====================================

let jobsCollection: Collection<Document>;
let applicationsCollection: Collection<Document>;
let savedJobsCollection: Collection<Document>;
let subscriptionsCollection: Collection<Document>;
let applicationUsageCollection: Collection<Document>;
let stripeEventsCollection: Collection<Document>;
let usersCollection: Collection<Document>;

// ====================================
// HELPER FUNCTIONS
// ====================================

const getJobId = (req: Request): string | null => {
  const id = req.params.id;

  return typeof id === "string" && ObjectId.isValid(id) ? id : null;
};

const getActiveSubscription = async (userId: string, role: string) => {
  return subscriptionsCollection.findOne({
    userId,
    role,
    status: "active",
    currentPeriodEnd: { $gt: new Date() },
  });
};

// Returns the most recent subscription for a user/role regardless of status.
// Used by the billing dashboard so canceled/expired subscriptions can still be
// shown instead of silently falling back to the Free plan.
const getLatestSubscription = async (userId: string, role: string) => {
  return subscriptionsCollection.findOne(
    { userId, role },
    { sort: { updatedAt: -1, createdAt: -1 } },
  );
};

// ====================================
// SEEKER USAGE TRACKING
// ====================================

const ensureApplicationUsageRecord = async (userId: string, email: string) => {
  const existingCount = await applicationsCollection.countDocuments({
    $or: [
      { applicantUserId: userId },
      {
        applicantEmail: email,
        applicantUserId: { $exists: false },
      },
    ],
  });

  try {
    await applicationUsageCollection.updateOne(
      { userId },
      {
        $setOnInsert: {
          userId,
          applicationsUsed: existingCount,
          createdAt: new Date(),
        },
        $set: {
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== 11000
    ) {
      throw error;
    }
  }
};

const reserveApplicationSlot = async (
  userId: string,
  email: string,
  isPremium: boolean,
) => {
  await ensureApplicationUsageRecord(userId, email);

  const filter: Document = { userId };

  if (!isPremium) {
    filter.applicationsUsed = {
      $lt: FREE_APPLICATION_LIMIT,
    };
  }

  const result = await applicationUsageCollection.updateOne(filter, {
    $inc: {
      applicationsUsed: 1,
    },
    $set: {
      updatedAt: new Date(),
    },
  });

  return result.modifiedCount === 1;
};

const releaseApplicationSlot = async (userId: string) => {
  await applicationUsageCollection.updateOne(
    {
      userId,
      applicationsUsed: { $gt: 0 },
    },
    {
      $inc: {
        applicationsUsed: -1,
      },
      $set: {
        updatedAt: new Date(),
      },
    },
  );
};

// ====================================
// RECRUITER ACTIVE JOB TRACKING
// ====================================

// Only active jobs count toward the Free Plan limit.
// Draft, closed and deleted jobs do not count.

const countActiveJobs = async (email: string, excludeJobId?: string) => {
  const filter: Document = {
    ownerEmail: email,
    status: "active",
    closed: { $ne: true },
  };

  if (excludeJobId && ObjectId.isValid(excludeJobId)) {
    filter._id = {
      $ne: new ObjectId(excludeJobId),
    };
  }

  return jobsCollection.countDocuments(filter);
};

// ====================================
// STRIPE SUBSCRIPTION SYNC
// ====================================

const saveStripeSubscription = async (
  subscription: Stripe.Subscription,
  fallbackMetadata: Record<string, string> = {},
  fallbackPriceId?: string | null,
) => {
  const existing = await subscriptionsCollection.findOne({
    stripeSubscriptionId: subscription.id,
  });

  const metadata = {
    ...fallbackMetadata,
    ...(existing?.userId ? { userId: String(existing.userId) } : {}),
    ...(existing?.role ? { role: String(existing.role) } : {}),
    ...(existing?.planId ? { planId: String(existing.planId) } : {}),
    ...(subscription.metadata || {}),
  };

  const priceId =
    getStripeObjectId(subscription.items?.data?.[0]?.price) ||
    fallbackPriceId ||
    null;

  const resolvedPlanId =
    getPlanIdForRole(
      (metadata.role === "recruiter" ? "recruiter" : "seeker") as
        | "seeker"
        | "recruiter",
    ) && resolvePlanFromPriceId(priceId)
      ? resolvePlanFromPriceId(priceId)
      : resolvePlanFromPriceId(priceId) ||
        (getPlanDefinition(metadata.planId)?.role === metadata.role
          ? (metadata.planId as HireLoopPlanId)
          : null);

  let userId = metadata.userId;
  let role = metadata.role as "seeker" | "recruiter" | undefined;

  if (!userId && existing?.userId) {
    userId = String(existing.userId);
  }

  if (!role && existing?.role) {
    const existingRole = String(existing.role);

    if (existingRole === "seeker" || existingRole === "recruiter") {
      role = existingRole;
    }
  }

  if ((!userId || !role) && existing?.stripeCustomerId) {
    const mappedByCustomer = await subscriptionsCollection.findOne(
      {
        stripeCustomerId: String(existing.stripeCustomerId),
        userId: { $exists: true },
        role: { $in: ["seeker", "recruiter"] },
      },
      { sort: { updatedAt: -1, createdAt: -1 } },
    );

    if (mappedByCustomer?.userId && !userId) {
      userId = String(mappedByCustomer.userId);
    }

    if (
      (mappedByCustomer?.role === "seeker" ||
        mappedByCustomer?.role === "recruiter") &&
      !role
    ) {
      role = mappedByCustomer.role;
    }
  }

  // Fallback mapping by Stripe customer ID stored on a previous subscription.
  if (!userId || !role) {
    const customerIdForLookup = getStripeObjectId(subscription.customer);

    if (customerIdForLookup) {
      const mappedByCustomer = await subscriptionsCollection.findOne(
        {
          stripeCustomerId: customerIdForLookup,
          userId: { $exists: true },
          role: { $in: ["seeker", "recruiter"] },
        },
        { sort: { updatedAt: -1, createdAt: -1 } },
      );

      if (mappedByCustomer?.userId && !userId) {
        userId = String(mappedByCustomer.userId);
      }

      if (
        (mappedByCustomer?.role === "seeker" ||
          mappedByCustomer?.role === "recruiter") &&
        !role
      ) {
        role = mappedByCustomer.role;
      }
    }
  }

  const inferredPlanId =
    resolvedPlanId || (role ? getPlanIdForRole(role) : null);

  if (inferredPlanId) {
    const definition = getPlanDefinition(inferredPlanId);

    // If Stripe price maps to a known plan, enforce that plan's role.
    if (definition) {
      role = definition.role;
    }
  }

  if (!userId || (role !== "seeker" && role !== "recruiter")) {
    // Never invent ownership. If Stripe sends a subscription we cannot map to
    // a HireLoop user, skip it instead of letting the webhook fail forever.
    console.warn("STRIPE SUBSCRIPTION SKIPPED (missing mapping):", {
      subscriptionId: subscription.id,
      stripeCustomerId: getStripeObjectId(subscription.customer),
      priceId,
    });
    return false;
  }

  const finalPlanId = inferredPlanId || getPlanIdForRole(role);
  const planDefinition = getPlanDefinition(finalPlanId) || PLAN_DEFINITIONS[getPlanIdForRole(role)];

  if (!ObjectId.isValid(userId)) {
    console.warn("STRIPE SUBSCRIPTION SKIPPED (invalid userId):", {
      subscriptionId: subscription.id,
      userId,
    });
    return false;
  }

  const userObjectId = new ObjectId(userId);
  const user = await usersCollection.findOne(
    { _id: userObjectId },
    { projection: { role: 1, email: 1 } },
  );

  if (!user) {
    console.warn("STRIPE SUBSCRIPTION SKIPPED (user not found):", {
      subscriptionId: subscription.id,
      userId,
    });
    return false;
  }

  const userRole = String(user.role || "")
    .trim()
    .toLowerCase();

  if (userRole !== role) {
    // Ensure the correct logged-in user/role receives the subscription update.
    console.warn("STRIPE SUBSCRIPTION SKIPPED (role mismatch):", {
      subscriptionId: subscription.id,
      userId,
      expectedRole: role,
      actualRole: userRole,
    });
    return false;
  }

  const subscriptionData = subscription as any;

  const periodStart =
    subscriptionData.current_period_start ??
    subscriptionData.items?.data?.[0]?.current_period_start;

  const periodEnd =
    subscriptionData.current_period_end ??
    subscriptionData.items?.data?.[0]?.current_period_end;

  const customerId = getStripeObjectId(subscription.customer);

  // "active" covers both active and trialing subscriptions so access checks
  // stay simple. The raw Stripe status is retained for display.
  const status =
    subscription.status === "active" || subscription.status === "trialing"
      ? "active"
      : subscription.status;

  const currentPeriodStart = periodStart ? new Date(periodStart * 1000) : null;
  const currentPeriodEnd = periodEnd ? new Date(periodEnd * 1000) : null;
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);

  const subscriptionDocument = {
    userId,
    userEmail: String(user.email || "").toLowerCase(),
    role,
    planId: finalPlanId,
    plan: finalPlanId,
    planName: planDefinition.planName,
    stripePriceId: priceId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    status,
    subscriptionStatus: status,
    stripeStatus: subscription.status,
    cancelAtPeriodEnd,
    canceledAt: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000)
      : null,
    currentPeriodStart,
    currentPeriodEnd,
    updatedAt: new Date(),
  };

  await subscriptionsCollection.updateOne(
    {
      stripeSubscriptionId: subscription.id,
    },
    {
      $set: subscriptionDocument,
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    {
      upsert: true,
    },
  );

  const userSubscriptionUpdate = {
    plan: finalPlanId,
    planName: status === "active" ? planDefinition.planName : "Free",
    subscriptionStatus: status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    stripeStatus: subscription.status,
    role,
    updatedAt: new Date(),
  };

  await usersCollection.updateOne(
    { _id: userObjectId },
    { $set: userSubscriptionUpdate },
  );

  console.log("STRIPE SUBSCRIPTION SYNCED:", {
    userId,
    role,
    planId: finalPlanId,
    priceId,
    subscriptionId: subscription.id,
    status,
    cancelAtPeriodEnd,
    currentPeriodEnd,
  });

  return true;
};

type SubscriptionState = {
  isPremium: boolean;
  status: string;
  planName: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
};

// Derives the user-facing subscription state from stored Stripe data.
// Premium access requires a backend-confirmed active status AND a future
// current period end — never a query parameter or client-supplied value.
const deriveSubscriptionState = (
  subscription: Document | null,
  role: string,
): SubscriptionState => {
  const fallbackPlanName =
    role === "seeker" ? "Seeker Premium" : "Recruiter Premium";

  if (!subscription) {
    return {
      isPremium: false,
      status: "inactive",
      planName: "Free",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    };
  }

  const currentPeriodEnd = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd)
    : null;

  const periodIsValid =
    currentPeriodEnd !== null &&
    !Number.isNaN(currentPeriodEnd.getTime()) &&
    currentPeriodEnd.getTime() > Date.now();

  const storedStatus = String(subscription.status || "");
  const cancelAtPeriodEnd = Boolean(subscription.cancelAtPeriodEnd);

  const isPremium = periodIsValid && storedStatus === "active";

  let status: string;

  if (!periodIsValid) {
    // No future paid period means no access, whether Stripe calls the
    // subscription canceled, unpaid, incomplete_expired, or simply stale.
    status = "expired";
  } else if (storedStatus === "active") {
    // A subscription set to cancel keeps Premium until the period ends.
    status = cancelAtPeriodEnd ? "canceled" : "active";
  } else {
    status = storedStatus || "inactive";
  }

  return {
    isPremium,
    status,
    planName: isPremium
      ? String(subscription.planName || fallbackPlanName)
      : "Free",
    cancelAtPeriodEnd: isPremium && cancelAtPeriodEnd,
    currentPeriodEnd,
  };
};

// ====================================
// HOME API
// ====================================

app.get("/", (_req: Request, res: Response) => {
  res.send("HireLoop Server Running");
});

// ====================================
// STRIPE WEBHOOK
// MUST BE BEFORE express.json()
// ====================================

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const signature = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!signature || !webhookSecret) {
      console.error("STRIPE WEBHOOK CONFIG ERROR:", {
        hasSignature: Boolean(signature),
        hasWebhookSecret: Boolean(webhookSecret),
      });

      res.status(400).send("Missing Stripe signature or webhook secret");
      return;
    }

    let event: Stripe.Event;

    try {
      event = getStripe().webhooks.constructEvent(
        req.body,
        signature,
        webhookSecret,
      );
    } catch (error) {
      console.error("STRIPE SIGNATURE ERROR:", error);

      res.status(400).send("Invalid webhook signature");
      return;
    }

    console.log("STRIPE WEBHOOK RECEIVED:", event.type, event.id);

    try {
      // Atomically claim the event before processing it. Concurrent duplicate
      // deliveries will see the existing claim and exit above, while a failed
      // processing attempt releases the claim so Stripe can retry.
      const claim = await stripeEventsCollection.updateOne(
        { eventId: event.id },
        {
          $setOnInsert: {
            eventId: event.id,
            eventType: event.type,
            processedAt: new Date(),
          },
        },
        { upsert: true },
      );

      if (claim.upsertedCount === 0) {
        res.status(200).json({
          received: true,
          duplicate: true,
        });
        return;
      }

      switch (event.type) {
        // ====================================
        // CHECKOUT COMPLETED
        // ====================================

        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;

          if (session.mode !== "subscription" || !session.subscription) {
            break;
          }

          const subscriptionId = getStripeObjectId(session.subscription);

          if (!subscriptionId) {
            break;
          }

          const subscription = await getStripe().subscriptions.retrieve(
            subscriptionId,
            { expand: ["items.data.price"] },
          );

          await saveStripeSubscription(subscription, {
            userId:
              session.metadata?.userId || session.client_reference_id || "",
            role: session.metadata?.role || "",
            planId: session.metadata?.planId || "",
          });

          console.log("CHECKOUT COMPLETED:", subscriptionId);

          break;
        }

        // ====================================
        // SUBSCRIPTION CREATED / UPDATED
        // ====================================

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const subscriptionEvent = event.data.object as Stripe.Subscription;
          const subscription = await getStripe().subscriptions.retrieve(
            subscriptionEvent.id,
            { expand: ["items.data.price"] },
          );

          await saveStripeSubscription(subscription);

          console.log(
            "SUBSCRIPTION EVENT PROCESSED:",
            event.type,
            subscription.id,
          );

          break;
        }

        // ====================================
        // SUBSCRIPTION DELETED
        // ====================================

        case "customer.subscription.deleted": {
          const subscriptionEvent = event.data.object as Stripe.Subscription;
          const subscription = await getStripe().subscriptions.retrieve(
            subscriptionEvent.id,
            { expand: ["items.data.price"] },
          );

          await saveStripeSubscription(subscription);

          console.log("SUBSCRIPTION CANCELED:", subscription.id);

          break;
        }

        // ====================================
        // INVOICE PAID (renewals / confirmations)
        // ====================================

        case "invoice.paid": {
          const invoice = event.data.object as Stripe.Invoice;
          const invoiceData = invoice as Stripe.Invoice & {
            subscription?: string | Stripe.Subscription | null;
          };
          const subscriptionId = getStripeObjectId(invoiceData.subscription);

          if (!subscriptionId) {
            break;
          }

          const subscription = await getStripe().subscriptions.retrieve(
            subscriptionId,
            { expand: ["items.data.price"] },
          );

          await saveStripeSubscription(subscription);

          console.log("INVOICE PAID:", invoice.id, subscriptionId);

          break;
        }

        // ====================================
        // INVOICE PAYMENT FAILED
        // ====================================

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const invoiceData = invoice as Stripe.Invoice & {
            subscription?: string | Stripe.Subscription | null;
          };
          const subscriptionId = getStripeObjectId(invoiceData.subscription);

          if (!subscriptionId) {
            break;
          }

          const subscription = await getStripe().subscriptions.retrieve(
            subscriptionId,
            { expand: ["items.data.price"] },
          );

          await saveStripeSubscription(subscription);

          console.log("INVOICE PAYMENT FAILED:", invoice.id, subscriptionId);

          break;
        }

        default: {
          console.log("UNHANDLED STRIPE EVENT:", event.type);
          break;
        }
      }

      res.status(200).json({
        received: true,
      });
    } catch (error) {
      console.error("STRIPE WEBHOOK PROCESSING ERROR:", error);

      // Release the claim so Stripe's retry can process this event again.
      try {
        await stripeEventsCollection.deleteOne({ eventId: event.id });
      } catch (cleanupError) {
        console.error("STRIPE WEBHOOK CLAIM CLEANUP ERROR:", cleanupError);
      }

      res.status(500).json({
        success: false,
        message: "Webhook processing failed",
      });
    }
  },
);

// JSON middleware must remain after Stripe webhook.
app.use(express.json());

// ====================================
// GET ALL JOBS
// ====================================

app.get("/api/jobs", async (_req: Request, res: Response) => {
  try {
    const jobs = await jobsCollection
      .find()
      .sort({
        createdAt: -1,
      })
      .toArray();

    const jobsWithApplicants = await Promise.all(
      jobs.map(async (job) => {
        const applicants = await applicationsCollection.countDocuments({
          jobId: job._id,
        });

        return {
          ...job,
          applicants,
        };
      }),
    );

    res.status(200).json({
      success: true,
      data: jobsWithApplicants,
    });
  } catch (error) {
    console.error("GET JOBS ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch jobs",
    });
  }
});

// ====================================
// GET SINGLE JOB
// ====================================

app.get("/api/jobs/:id", async (req: Request, res: Response) => {
  try {
    const id = getJobId(req);

    if (!id) {
      res.status(400).json({
        success: false,
        message: "Invalid job ID",
      });
      return;
    }

    const job = await jobsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!job) {
      res.status(404).json({
        success: false,
        message: "Job not found",
      });
      return;
    }

    const applicants = await applicationsCollection.countDocuments({
      jobId: job._id,
    });

    res.status(200).json({
      success: true,
      data: {
        ...job,
        applicants,
      },
    });
  } catch (error) {
    console.error("GET SINGLE JOB ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch job details",
    });
  }
});

// ====================================
// CREATE JOB
// ====================================

app.post(
  "/api/jobs",
  verifyUser,
  verifyRecruiter,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.authUser!;
      const ownerEmail = user.email;

      const {
        title,
        company,
        location,
        salary,
        category,
        description,
        status = "active",
      } = req.body;

      if (
        typeof title !== "string" ||
        !title.trim() ||
        typeof company !== "string" ||
        !company.trim() ||
        typeof location !== "string" ||
        !location.trim()
      ) {
        res.status(400).json({
          success: false,
          message: "Title, company and location are required",
        });
        return;
      }

      if (!["active", "draft"].includes(status)) {
        res.status(400).json({
          success: false,
          message: "Status must be active or draft",
        });
        return;
      }

      let publishedAt: Date | null = null;

      if (status === "active") {
        const subscription = await getActiveSubscription(user.id, "recruiter");

        if (!subscription) {
          const activeJobs = await countActiveJobs(ownerEmail);

          if (activeJobs >= FREE_PUBLISHED_JOB_LIMIT) {
            res.status(429).json({
              success: false,
              code: "PUBLISHED_JOB_LIMIT_REACHED",
              message:
                "You have reached your free active job limit. Upgrade your plan to publish more jobs.",
              limit: FREE_PUBLISHED_JOB_LIMIT,
              used: activeJobs,
              remaining: 0,
            });
            return;
          }
        }

        publishedAt = new Date();
      }

      const newJob = {
        title: title.trim(),
        company: company.trim(),
        location: location.trim(),
        salary: typeof salary === "string" ? salary.trim() : "",
        category: typeof category === "string" ? category.trim() : "",
        description: typeof description === "string" ? description.trim() : "",
        status,
        closed: status === "draft",
        recruiterId: user.id,
        ownerEmail,
        publishedAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await jobsCollection.insertOne(newJob);

      res.status(201).json({
        success: true,
        message:
          status === "draft"
            ? "Job saved as draft"
            : "Job published successfully",
        data: {
          _id: result.insertedId,
          ...newJob,
        },
      });
    } catch (error) {
      console.error("CREATE JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to create job",
      });
    }
  },
);

// ====================================
// UPDATE JOB
// ====================================

app.patch(
  "/api/jobs/:id",
  verifyUser,
  verifyRecruiter,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.authUser!;
      const ownerEmail = user.email;

      const id = getJobId(req);

      if (!id) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const existingJob = await jobsCollection.findOne({
        _id: new ObjectId(id),
        ownerEmail,
      });

      if (!existingJob) {
        res.status(404).json({
          success: false,
          message: "Job not found or unauthorized",
        });
        return;
      }

      const allowedFields = [
        "title",
        "company",
        "location",
        "salary",
        "category",
        "description",
        "status",
      ];

      const updateData: Document = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      if (
        updateData.status !== undefined &&
        !["active", "draft", "closed"].includes(updateData.status)
      ) {
        res.status(400).json({
          success: false,
          message: "Invalid job status",
        });
        return;
      }

      const isPublishing =
        updateData.status === "active" &&
        !(existingJob.status === "active" && existingJob.closed !== true);

      if (isPublishing) {
        const subscription = await getActiveSubscription(user.id, "recruiter");

        if (!subscription) {
          const activeJobs = await countActiveJobs(ownerEmail, id);

          if (activeJobs >= FREE_PUBLISHED_JOB_LIMIT) {
            res.status(429).json({
              success: false,
              code: "PUBLISHED_JOB_LIMIT_REACHED",
              message:
                "You have reached your free active job limit. Upgrade your plan to publish more jobs.",
              limit: FREE_PUBLISHED_JOB_LIMIT,
              used: activeJobs,
              remaining: 0,
            });
            return;
          }
        }

        updateData.publishedAt = new Date();
      }

      if (updateData.status === "draft") {
        updateData.closed = true;
      } else if (updateData.status === "active") {
        updateData.closed = false;
      } else if (updateData.status === "closed") {
        updateData.closed = true;
      }

      if (Object.keys(updateData).length === 0) {
        res.status(400).json({
          success: false,
          message: "No valid fields to update",
        });
        return;
      }

      updateData.updatedAt = new Date();

      const result = await jobsCollection.updateOne(
        {
          _id: new ObjectId(id),
          ownerEmail,
        },
        {
          $set: updateData,
        },
      );

      if (result.matchedCount === 0) {
        res.status(404).json({
          success: false,
          message: "Job not found",
        });
        return;
      }

      const updatedJob = await jobsCollection.findOne({
        _id: new ObjectId(id),
      });

      res.status(200).json({
        success: true,
        message: "Job updated successfully",
        data: updatedJob,
      });
    } catch (error) {
      console.error("UPDATE JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to update job",
      });
    }
  },
);

// ====================================
// DELETE JOB
// ====================================

app.delete(
  "/api/jobs/:id",
  verifyUser,
  verifyRecruiter,
  async (req: AuthRequest, res: Response) => {
    try {
      const id = getJobId(req);

      if (!id) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const jobObjectId = new ObjectId(id);

      const result = await jobsCollection.deleteOne({
        _id: jobObjectId,
        ownerEmail: req.authUser!.email,
      });

      if (result.deletedCount === 0) {
        res.status(404).json({
          success: false,
          message: "Job not found or unauthorized",
        });
        return;
      }

      await savedJobsCollection.deleteMany({
        jobId: jobObjectId,
      });

      res.status(200).json({
        success: true,
        message: "Job deleted successfully",
      });
    } catch (error) {
      console.error("DELETE JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to delete job",
      });
    }
  },
);

// ====================================
// ADMIN DELETE JOB
// ====================================

/**
 * Admin-only job removal.
 *
 * `verifyUser` loads the role from MongoDB for every request and `verifyAdmin`
 * rejects anyone who is not an administrator, so the JWT role claim can never
 * be used to escalate access. Recruiters keep using DELETE /api/jobs/:id,
 * which still filters by `ownerEmail` and is therefore restricted to their own
 * jobs.
 */
app.delete(
  "/api/admin/jobs/:id",
  verifyUser,
  verifyAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const id = getJobId(req);

      if (!id) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const jobObjectId = new ObjectId(id);

      // Admins are explicitly allowed to remove any listing.
      const result = await jobsCollection.deleteOne({
        _id: jobObjectId,
      });

      if (result.deletedCount === 0) {
        res.status(404).json({
          success: false,
          message: "Job not found",
        });
        return;
      }

      await savedJobsCollection.deleteMany({
        jobId: jobObjectId,
      });

      res.status(200).json({
        success: true,
        message: "Job deleted successfully",
      });
    } catch (error) {
      console.error("ADMIN DELETE JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to delete job",
      });
    }
  },
);

// ====================================
// SAVED JOBS
// ====================================

// SAVE JOB

app.post(
  "/api/saved-jobs",
  verifyUser,
  verifySeeker,
  async (req: AuthRequest, res: Response) => {
    try {
      const { jobId } = req.body;
      const user = req.authUser!;

      if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const jobObjectId = new ObjectId(jobId);

      const job = await jobsCollection.findOne({
        _id: jobObjectId,
      });

      if (!job) {
        res.status(404).json({
          success: false,
          message: "Job not found",
        });
        return;
      }

      if (
        job.status === "draft" ||
        job.status === "closed" ||
        job.closed === true
      ) {
        res.status(400).json({
          success: false,
          message: "This job is not available for saving",
        });
        return;
      }

      const savedJob = {
        jobId: jobObjectId,
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        savedAt: new Date(),
      };

      try {
        const result = await savedJobsCollection.insertOne(savedJob);

        res.status(201).json({
          success: true,
          message: "Job saved successfully",
          data: {
            _id: result.insertedId,
            ...savedJob,
          },
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 11000
        ) {
          res.status(409).json({
            success: false,
            message: "You have already saved this job",
          });
          return;
        }

        throw error;
      }
    } catch (error) {
      console.error("SAVE JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to save job",
      });
    }
  },
);

// GET SAVED JOBS

app.get(
  "/api/saved-jobs",
  verifyUser,
  verifySeeker,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.authUser!;

      const savedJobs = await savedJobsCollection
        .aggregate([
          { $match: { userId: user.id } },
          { $sort: { savedAt: -1 } },
          {
            $lookup: {
              from: "jobs",
              localField: "jobId",
              foreignField: "_id",
              as: "job",
            },
          },
          {
            $unwind: {
              path: "$job",
              preserveNullAndEmptyArrays: false,
            },
          },
          {
            $project: {
              _id: 1,
              jobId: { $toString: "$jobId" },
              userId: 1,
              userEmail: 1,
              userName: 1,
              savedAt: 1,
              title: "$job.title",
              company: "$job.company",
              location: "$job.location",
              salary: "$job.salary",
              category: "$job.category",
              description: "$job.description",
              status: "$job.status",
              closed: "$job.closed",
            },
          },
        ])
        .toArray();

      res.status(200).json({
        success: true,
        data: savedJobs,
        total: savedJobs.length,
      });
    } catch (error) {
      console.error("GET SAVED JOBS ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch saved jobs",
      });
    }
  },
);

// CHECK SAVED JOB

app.get(
  "/api/saved-jobs/check/:jobId",
  verifyUser,
  verifySeeker,
  async (req: AuthRequest, res: Response) => {
    try {
      const { jobId } = req.params;
      const user = req.authUser!;

      if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const savedJob = await savedJobsCollection.findOne({
        jobId: new ObjectId(jobId),
        userId: user.id,
      });

      res.status(200).json({
        success: true,
        saved: Boolean(savedJob),
      });
    } catch (error) {
      console.error("CHECK SAVED JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to check saved job",
      });
    }
  },
);

// DELETE SAVED JOB

app.delete(
  "/api/saved-jobs/:jobId",
  verifyUser,
  verifySeeker,
  async (req: AuthRequest, res: Response) => {
    try {
      const { jobId } = req.params;
      const user = req.authUser!;

      if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const result = await savedJobsCollection.deleteOne({
        jobId: new ObjectId(jobId),
        userId: user.id,
      });

      if (result.deletedCount === 0) {
        res.status(404).json({
          success: false,
          message: "Saved job not found",
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "Job removed from saved jobs",
      });
    } catch (error) {
      console.error("REMOVE SAVED JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to remove saved job",
      });
    }
  },
);

// ====================================
// APPLICATIONS
// ====================================

// CHECK APPLICATION

app.get(
  "/api/applications/check",
  verifyUser,
  verifySeeker,
  async (req: AuthRequest, res: Response) => {
    try {
      const { jobId } = req.query;
      const user = req.authUser!;

      if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
        res.status(400).json({
          success: false,
          message: "A valid job ID is required",
        });
        return;
      }

      const existingApplication = await applicationsCollection.findOne({
        jobId: new ObjectId(jobId),
        $or: [{ applicantUserId: user.id }, { applicantEmail: user.email }],
      });

      res.status(200).json({
        success: true,
        applied: Boolean(existingApplication),
      });
    } catch (error) {
      console.error("CHECK APPLICATION ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to check application",
      });
    }
  },
);

// APPLY FOR JOB

app.post(
  "/api/applications",
  verifyUser,
  verifySeeker,
  async (req: AuthRequest, res: Response) => {
    const user = req.authUser!;
    let reserved = false;

    try {
      const { jobId, experience, resumeUrl, coverLetter } = req.body;

      if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
        res.status(400).json({
          success: false,
          message: "A valid job ID is required",
        });
        return;
      }

      const jobObjectId = new ObjectId(jobId);

      const job = await jobsCollection.findOne({
        _id: jobObjectId,
      });

      if (!job) {
        res.status(404).json({
          success: false,
          message: "Job not found",
        });
        return;
      }

      if (
        job.closed === true ||
        job.status === "draft" ||
        job.status === "closed"
      ) {
        res.status(400).json({
          success: false,
          message: "This job is no longer accepting applications",
        });
        return;
      }

      const existingApplication = await applicationsCollection.findOne({
        jobId: jobObjectId,
        $or: [{ applicantUserId: user.id }, { applicantEmail: user.email }],
      });

      if (existingApplication) {
        res.status(409).json({
          success: false,
          message: "You have already applied for this job",
        });
        return;
      }

      const subscription = await getActiveSubscription(user.id, "seeker");

      const isPremium = Boolean(subscription);

      const slotReserved = await reserveApplicationSlot(
        user.id,
        user.email,
        isPremium,
      );

      if (!slotReserved) {
        const usage = await applicationUsageCollection.findOne({
          userId: user.id,
        });

        res.status(429).json({
          success: false,
          code: "APPLICATION_LIMIT_REACHED",
          message:
            "You have reached your free application limit. Upgrade your plan to continue.",
          limit: FREE_APPLICATION_LIMIT,
          used: Number(usage?.applicationsUsed ?? FREE_APPLICATION_LIMIT),
        });
        return;
      }

      reserved = true;

      const newApplication = {
        jobId: jobObjectId,
        jobTitle: String(job.title || ""),
        company: String(job.company || ""),
        recruiterEmail: String(job.ownerEmail || "").toLowerCase(),
        applicantUserId: user.id,
        applicantName: user.name,
        applicantEmail: user.email,
        experience: typeof experience === "string" ? experience.trim() : "",
        resumeUrl: typeof resumeUrl === "string" ? resumeUrl.trim() : "",
        coverLetter: typeof coverLetter === "string" ? coverLetter.trim() : "",
        status: "Applied",
        appliedAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await applicationsCollection.insertOne(newApplication);

      reserved = false;

      res.status(201).json({
        success: true,
        message: "Application submitted successfully",
        data: {
          _id: result.insertedId,
          ...newApplication,
        },
      });
    } catch (error) {
      if (reserved) {
        try {
          await releaseApplicationSlot(user.id);
        } catch (releaseError) {
          console.error("RELEASE APPLICATION SLOT ERROR:", releaseError);
        }
      }

      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 11000
      ) {
        res.status(409).json({
          success: false,
          message: "You have already applied for this job",
        });
        return;
      }

      console.error("APPLY JOB ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to submit application",
      });
    }
  },
);

// ====================================
// RECRUITER APPLICATIONS
// ====================================

// GET ALL RECRUITER APPLICATIONS

app.get(
  "/api/applications/recruiter",
  verifyUser,
  verifyRecruiter,
  async (req: AuthRequest, res: Response) => {
    try {
      const recruiter = req.authUser!;

      const recruiterJobs = await jobsCollection
        .find({ ownerEmail: recruiter.email })
        .project({ _id: 1 })
        .toArray();

      const jobIds = recruiterJobs.map((job) => job._id);

      if (jobIds.length === 0) {
        res.status(200).json({
          success: true,
          data: [],
          total: 0,
        });
        return;
      }

      const applications = await applicationsCollection
        .find({ jobId: { $in: jobIds } })
        .sort({ appliedAt: -1 })
        .toArray();

      const data = applications.map((application) => ({
        id: application._id.toString(),
        jobId: application.jobId.toString(),
        name: application.applicantName,
        email: application.applicantEmail,
        role: application.jobTitle,
        applied: application.appliedAt,
        experience: application.experience || "Not provided",
        resumeUrl: application.resumeUrl || "",
        coverLetter: application.coverLetter || "",
        status: application.status,
      }));

      res.status(200).json({
        success: true,
        data,
        total: data.length,
      });
    } catch (error) {
      console.error("GET RECRUITER APPLICATIONS ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch applications",
      });
    }
  },
);

// GET APPLICANTS FOR SPECIFIC JOB

app.get(
  "/api/applications/recruiter/:jobId",
  verifyUser,
  verifyRecruiter,
  async (req: AuthRequest, res: Response) => {
    try {
      const { jobId } = req.params;
      const recruiter = req.authUser!;

      if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const job = await jobsCollection.findOne({
        _id: new ObjectId(jobId),
        ownerEmail: recruiter.email,
      });

      if (!job) {
        res.status(404).json({
          success: false,
          message: "Job not found or unauthorized",
        });
        return;
      }

      const applications = await applicationsCollection
        .find({ jobId: new ObjectId(jobId) })
        .sort({ appliedAt: -1 })
        .toArray();

      const data = applications.map((application) => ({
        id: application._id.toString(),
        jobId: application.jobId.toString(),
        name: application.applicantName,
        email: application.applicantEmail,
        role: application.jobTitle,
        company: application.company,
        applied: application.appliedAt,
        experience: application.experience || "Not provided",
        resumeUrl: application.resumeUrl || "",
        coverLetter: application.coverLetter || "",
        status: application.status || "Applied",
      }));

      res.status(200).json({
        success: true,
        data,
        total: data.length,
        job: {
          id: job._id.toString(),
          title: job.title,
          company: job.company,
        },
      });
    } catch (error) {
      console.error("GET JOB APPLICANTS ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch job applicants",
      });
    }
  },
);

// UPDATE APPLICATION STATUS

app.patch(
  "/api/applications/:id/status",
  verifyUser,
  verifyRecruiter,
  async (req: AuthRequest, res: Response) => {
    try {
      const id = getJobId(req);
      const recruiter = req.authUser!;

      const allowedStatuses = [
        "Applied",
        "Under Review",
        "Shortlisted",
        "Offered",
        "Rejected",
      ];

      const { status } = req.body;

      if (!id) {
        res.status(400).json({
          success: false,
          message: "Invalid application ID",
        });
        return;
      }

      if (typeof status !== "string" || !allowedStatuses.includes(status)) {
        res.status(400).json({
          success: false,
          message: "Invalid application status",
        });
        return;
      }

      const application = await applicationsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!application) {
        res.status(404).json({
          success: false,
          message: "Application not found",
        });
        return;
      }

      const job = await jobsCollection.findOne({
        _id: application.jobId,
        ownerEmail: recruiter.email,
      });

      if (!job) {
        res.status(403).json({
          success: false,
          message: "You cannot update this application",
        });
        return;
      }

      await applicationsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status,
            updatedAt: new Date(),
          },
        },
      );

      res.status(200).json({
        success: true,
        message: "Application status updated successfully",
      });
    } catch (error) {
      console.error("UPDATE APPLICATION STATUS ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to update application status",
      });
    }
  },
);

// ====================================
// BILLING SUMMARY
// ====================================

app.get(
  "/api/billing/summary",
  verifyUser,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.authUser!;

      if (!["seeker", "recruiter"].includes(user.role)) {
        res.status(403).json({
          success: false,
          message: "Billing is not available for this role",
        });
        return;
      }

      const latestSubscription = await getLatestSubscription(
        user.id,
        user.role,
      );

      const subscriptionState = deriveSubscriptionState(
        latestSubscription,
        user.role,
      );

      const isPremium = subscriptionState.isPremium;

      // SEEKER BILLING

      if (user.role === "seeker") {
        await ensureApplicationUsageRecord(user.id, user.email);

        const usage = await applicationUsageCollection.findOne({
          userId: user.id,
        });

        const applicationsUsed = Number(usage?.applicationsUsed ?? 0);

        res.status(200).json({
          success: true,
          data: {
            role: "seeker",
            plan: isPremium ? "premium" : "free",
            planId: isPremium
              ? String(latestSubscription?.planId || "seeker_premium")
              : "free",
            planName: subscriptionState.planName,
            subscriptionStatus: subscriptionState.status,
            cancelAtPeriodEnd: subscriptionState.cancelAtPeriodEnd,
            applicationsUsed,
            applicationLimit: isPremium ? null : FREE_APPLICATION_LIMIT,
            remainingApplications: isPremium
              ? null
              : Math.max(0, FREE_APPLICATION_LIMIT - applicationsUsed),
            currentPeriodEnd: subscriptionState.currentPeriodEnd,
            renewalDate: subscriptionState.currentPeriodEnd,
          },
        });

        return;
      }

      // RECRUITER BILLING

      const publishedJobsUsed = await countActiveJobs(user.email);

      res.status(200).json({
        success: true,
        data: {
          role: "recruiter",
          plan: isPremium ? "premium" : "free",
          planId: isPremium
            ? String(latestSubscription?.planId || "recruiter_premium")
            : "free",
          planName: subscriptionState.planName,
          subscriptionStatus: subscriptionState.status,
          cancelAtPeriodEnd: subscriptionState.cancelAtPeriodEnd,
          publishedJobsUsed,
          publishedJobLimit: isPremium ? null : FREE_PUBLISHED_JOB_LIMIT,
          remainingPublishedJobs: isPremium
            ? null
            : Math.max(0, FREE_PUBLISHED_JOB_LIMIT - publishedJobsUsed),
          currentPeriodEnd: subscriptionState.currentPeriodEnd,
          renewalDate: subscriptionState.currentPeriodEnd,
        },
      });
    } catch (error) {
      console.error("GET BILLING SUMMARY ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch billing information",
      });
    }
  },
);

// ====================================
// STRIPE CHECKOUT SESSION
// ====================================

const normalizeRequestedPlanId = (
  value: unknown,
  role: "seeker" | "recruiter",
): HireLoopPlanId | null => {
  if (typeof value !== "string") {
    return getPlanIdForRole(role);
  }

  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return getPlanIdForRole(role);
  }

  if (normalized === "free" || normalized === "starter") {
    return null;
  }

  if (normalized === "premium") {
    return getPlanIdForRole(role);
  }

  if (normalized === "seeker_premium" || normalized === "seeker-premium") {
    return role === "seeker" ? "seeker_premium" : null;
  }

  if (
    normalized === "recruiter_premium" ||
    normalized === "recruiter-premium"
  ) {
    return role === "recruiter" ? "recruiter_premium" : null;
  }

  // Backward-compatible: role-scoped premium is the only paid plan today.
  if (normalized === "growth") {
    return getPlanIdForRole(role);
  }

  return null;
};

const createCheckoutSession = async (
  req: AuthRequest,
  res: Response,
  responseFormat: "standard" | "nested",
) => {
  try {
    const user = req.authUser;

    if (!user) {
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
      return;
    }

    if (!["seeker", "recruiter"].includes(user.role)) {
      res.status(403).json({
        success: false,
        message: "Invalid subscription role",
      });
      return;
    }

    const frontendUrl = normalizeOrigin(process.env.FRONTEND_URL);

    if (!frontendUrl) {
      res.status(500).json({
        success: false,
        message: "FRONTEND_URL is not configured",
      });
      return;
    }

    const requestedPlanId = normalizeRequestedPlanId(
      req.body?.planId ?? req.body?.plan,
      user.role as "seeker" | "recruiter",
    );

    if (req.body?.planId || req.body?.plan) {
      if (!requestedPlanId) {
        res.status(400).json({
          success: false,
          message:
            "The selected plan is not available for your account. Please choose a valid plan from the billing page.",
        });
        return;
      }
    }

    const planId = requestedPlanId || getPlanIdForRole(user.role as "seeker" | "recruiter");
    const planDefinition = getPlanDefinition(planId);

    if (!planDefinition || planDefinition.role !== user.role) {
      res.status(400).json({
        success: false,
        message: "The selected plan is not available for your account.",
      });
      return;
    }

    const priceId = getConfiguredPriceId(planId);

    if (!priceId || !priceId.startsWith("price_")) {
      res.status(500).json({
        success: false,
        message:
          "Invalid Stripe Price ID. Use a recurring Price ID starting with price_, not a Product ID.",
      });
      return;
    }

    const existingSubscription = await getActiveSubscription(
      user.id,
      user.role,
    );

    if (existingSubscription) {
      res.status(400).json({
        success: false,
        message: "You already have an active subscription",
      });
      return;
    }

    const successPath =
      user.role === "recruiter"
        ? "/dashboard/recruiter/billing"
        : "/dashboard/seeker/billing";

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: {
        userId: user.id,
        userEmail: user.email,
        role: user.role,
        planId,
        planName: planDefinition.planName,
      },
      subscription_data: {
        metadata: {
          userId: user.id,
          userEmail: user.email,
          role: user.role,
          planId,
          planName: planDefinition.planName,
        },
      },
      success_url: `${frontendUrl}${successPath}?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}${successPath}?canceled=true`,
    });

    if (!session.url) {
      throw new Error("Stripe checkout session URL is missing");
    }

    console.log("STRIPE CHECKOUT SESSION CREATED:", {
      userId: user.id,
      role: user.role,
      planId,
      priceId,
      sessionId: session.id,
    });

    if (responseFormat === "nested") {
      res.status(200).json({
        success: true,
        data: {
          url: session.url,
          sessionId: session.id,
          planId,
        },
      });

      return;
    }

    res.status(200).json({
      success: true,
      url: session.url,
      sessionId: session.id,
      planId,
    });
  } catch (error) {
    console.error("CREATE CHECKOUT SESSION ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create checkout session",
    });
  }
};

// Original checkout endpoint

app.post(
  "/api/billing/checkout-session",
  verifyUser,
  async (req: AuthRequest, res: Response) => {
    await createCheckoutSession(req, res, "standard");
  },
);

// Frontend-compatible checkout endpoint

app.post(
  "/api/billing/create-checkout-session",
  verifyUser,
  async (req: AuthRequest, res: Response) => {
    await createCheckoutSession(req, res, "nested");
  },
);

// ====================================
// ADMIN USER MANAGEMENT
// ====================================

const ADMIN_MANAGED_ROLES = ["seeker", "recruiter", "admin"] as const;

type ManagedRole = (typeof ADMIN_MANAGED_ROLES)[number];

const isManagedRole = (value: unknown): value is ManagedRole =>
  typeof value === "string" &&
  (ADMIN_MANAGED_ROLES as readonly string[]).includes(value);

// Never misrepresent a missing or invalid database role as a seeker.
const normalizeStoredRole = (value: unknown): ManagedRole | "unknown" =>
  isManagedRole(value) ? value : "unknown";

// Explicit allow-list of user fields that are safe to return to the admin
// dashboard. Password hashes live in Better Auth's account collection, but the
// projection guarantees no credential or token field can leak even if the
// schema changes later.
const ADMIN_USER_PROJECTION = {
  name: 1,
  email: 1,
  role: 1,
  emailVerified: 1,
  image: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

type AdminUserView = {
  id: string;
  name: string;
  email: string;
  role: ManagedRole | "unknown";
  emailVerified: boolean;
  image: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const toIsoString = (value: unknown): string | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return null;
};

const sanitizeAdminUser = (user: Document): AdminUserView => ({
  id: String(user._id),
  name: String(user.name || "").trim() || "Unnamed user",
  email: String(user.email || "")
    .trim()
    .toLowerCase(),
  role: normalizeStoredRole(user.role),
  emailVerified: Boolean(user.emailVerified),
  image: typeof user.image === "string" && user.image ? user.image : null,
  createdAt: toIsoString(user.createdAt),
  updatedAt: toIsoString(user.updatedAt),
});

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

app.get(
  "/api/admin/users",
  verifyUser,
  verifyAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const rawPage = Number(req.query.page ?? 1);
      const rawLimit = Number(req.query.limit ?? 10);

      const page = Number.isFinite(rawPage)
        ? Math.max(1, Math.floor(rawPage))
        : 1;

      const limit = Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
        : 10;

      const search =
        typeof req.query.search === "string" ? req.query.search.trim() : "";

      const roleParam =
        typeof req.query.role === "string"
          ? req.query.role.trim().toLowerCase()
          : "all";

      if (roleParam !== "all" && !isManagedRole(roleParam)) {
        res.status(400).json({
          success: false,
          message:
            "Role filter must be one of all, seeker, recruiter, or admin",
        });
        return;
      }

      if (search.length > 120) {
        res.status(400).json({
          success: false,
          message: "Search query is too long",
        });
        return;
      }

      const filter: Document = {};

      if (roleParam !== "all") {
        // Match case-insensitively so the list agrees with the aggregated
        // role counts, which lowercase every stored role.
        filter.role = { $regex: `^${roleParam}$`, $options: "i" };
      }

      if (search) {
        const pattern = new RegExp(escapeRegex(search), "i");

        filter.$or = [{ name: pattern }, { email: pattern }];
      }

      const [total, users, roleCounts, totalUsers] = await Promise.all([
        usersCollection.countDocuments(filter),
        usersCollection
          .find(filter, { projection: ADMIN_USER_PROJECTION })
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        usersCollection
          .aggregate([
            {
              $group: {
                _id: { $toLower: { $ifNull: ["$role", ""] } },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        usersCollection.countDocuments({}),
      ]);

      const countFor = (role: string) =>
        Number(
          roleCounts.find((entry) => String(entry._id) === role)?.count ?? 0,
        );

      const recruiters = countFor("recruiter");
      const admins = countFor("admin");
      const seekers = countFor("seeker");

      res.status(200).json({
        success: true,
        data: {
          users: users.map(sanitizeAdminUser),
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
          counts: {
            total: totalUsers,
            seekers,
            recruiters,
            admins,
            unknownRoles: Math.max(
              0,
              totalUsers - seekers - recruiters - admins,
            ),
          },
        },
      });
    } catch (error) {
      console.error("ADMIN LIST USERS ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to load users",
      });
    }
  },
);

app.patch(
  "/api/admin/users/:id/role",
  verifyUser,
  verifyAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const admin = req.authUser!;
      const targetId = req.params.id;

      if (typeof targetId !== "string" || !ObjectId.isValid(targetId)) {
        res.status(400).json({
          success: false,
          message: "A valid user ID is required",
        });
        return;
      }

      const requestedRole =
        typeof req.body?.role === "string"
          ? req.body.role.trim().toLowerCase()
          : "";

      if (!isManagedRole(requestedRole)) {
        res.status(400).json({
          success: false,
          message: "Role must be one of seeker, recruiter, or admin",
        });
        return;
      }

      // An admin can never demote themselves, which would lock the console.
      if (admin.id === targetId && requestedRole !== "admin") {
        res.status(400).json({
          success: false,
          message: "You cannot remove your own admin role",
        });
        return;
      }

      const updated = await usersCollection.findOneAndUpdate(
        { _id: new ObjectId(targetId) },
        {
          $set: {
            role: requestedRole,
            updatedAt: new Date(),
          },
        },
        {
          returnDocument: "after",
          projection: ADMIN_USER_PROJECTION,
        },
      );

      if (!updated) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      console.log("ADMIN ROLE UPDATED:", {
        adminId: admin.id,
        targetUserId: targetId,
        role: requestedRole,
      });

      res.status(200).json({
        success: true,
        message: "User role updated successfully",
        data: sanitizeAdminUser(updated),
      });
    } catch (error) {
      console.error("ADMIN UPDATE USER ROLE ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Failed to update user role",
      });
    }
  },
);

// ====================================
// ERROR HANDLER
// ====================================

app.use(
  (error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("SERVER ERROR:", error.message);

    if (error.message.startsWith("CORS blocked")) {
      res.status(403).json({
        success: false,
        message: "Origin not allowed by CORS",
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  },
);

// ====================================
// START SERVER
// ====================================

const startServer = async () => {
  try {
    const db = await connectDB();

    jobsCollection = db.collection("jobs");
    applicationsCollection = db.collection("applications");
    savedJobsCollection = db.collection("savedJobs");
    subscriptionsCollection = db.collection("subscriptions");
    applicationUsageCollection = db.collection("applicationUsage");
    stripeEventsCollection = db.collection("stripeEvents");
    usersCollection = db.collection("user");

    // ====================================
    // APPLICATION INDEXES
    // ====================================

    await applicationsCollection.createIndex(
      {
        jobId: 1,
        applicantUserId: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          applicantUserId: { $type: "string" },
        },
      },
    );

    await applicationsCollection.createIndex({
      applicantUserId: 1,
      appliedAt: -1,
    });

    // ====================================
    // USAGE INDEXES
    // ====================================

    await applicationUsageCollection.createIndex(
      { userId: 1 },
      { unique: true },
    );

    // ====================================
    // JOB INDEXES
    // ====================================

    await jobsCollection.createIndex({
      ownerEmail: 1,
      status: 1,
      closed: 1,
    });

    // ====================================
    // SUBSCRIPTION INDEXES
    // ====================================

    await subscriptionsCollection.createIndex(
      { stripeSubscriptionId: 1 },
      {
        unique: true,
        sparse: true,
      },
    );

    await subscriptionsCollection.createIndex({
      userId: 1,
      role: 1,
      status: 1,
    });

    // ====================================
    // SAVED JOBS INDEXES
    // ====================================

    await savedJobsCollection.createIndex(
      {
        jobId: 1,
        userId: 1,
      },
      { unique: true },
    );

    await savedJobsCollection.createIndex({
      userId: 1,
      savedAt: -1,
    });

    // ====================================
    // STRIPE WEBHOOK INDEX
    // ====================================

    await stripeEventsCollection.createIndex({ eventId: 1 }, { unique: true });

    // ====================================
    // ADMIN USERS INDEXES
    // ====================================

    // Supports the admin user list sorted newest-first and filtered by role.
    // The `user` collection is owned by Better Auth; this only adds a
    // non-unique index and never changes its schema.
    await usersCollection.createIndex({ role: 1, createdAt: -1 });
    await usersCollection.createIndex({ createdAt: -1 });

    console.log("MongoDB collections connected successfully");
    console.log("Seeker application limit: 5");
    console.log("Recruiter active job limit: 5");
    console.log("Recruiter Premium: Unlimited active jobs");
    console.log("Stripe subscription indexes ready");
    console.log("Stripe webhook event index ready");
    console.log("Saved Jobs indexes ready");

    app.listen(PORT, () => {
      console.log(`HireLoop server running on port ${PORT}`);
      console.log("Allowed frontend origins:", allowedOrigins);
    });
  } catch (error) {
    console.error("SERVER STARTUP FAILED:", error);
    process.exit(1);
  }
};

startServer();
