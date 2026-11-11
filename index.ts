import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ObjectId, type Collection, type Document } from "mongodb";
import { connectDB } from "./config/db.js";
import {
  verifyUser,
  verifySeeker,
  type AuthRequest,
} from "./middleware/auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ------------------------------------
// CORS CONFIGURATION
// ------------------------------------

const normalizeOrigin = (value?: string) => {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const allowedOrigins = Array.from(
  new Set(
    [
      "http://localhost:3000",
      process.env.FRONTEND_URL,
      process.env.AUTH_BASE_URL,
    ]
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin)),
  ),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

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

app.use(express.json());

// ------------------------------------
// DATABASE COLLECTIONS
// ------------------------------------

let jobsCollection: Collection<Document>;
let applicationsCollection: Collection<Document>;
let savedJobsCollection: Collection<Document>;

// ------------------------------------
// HOME API
// ------------------------------------

app.get("/", (_req: Request, res: Response) => {
  res.send("HireLoop Server Running");
});

// ------------------------------------
// GET ALL JOBS
// ------------------------------------

app.get("/api/jobs", async (_req: Request, res: Response) => {
  try {
    const jobs = await jobsCollection.find().sort({ createdAt: -1 }).toArray();

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

// ------------------------------------
// GET SINGLE JOB BY ID
// ------------------------------------

app.get("/api/jobs/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    if (typeof id !== "string" || !ObjectId.isValid(id)) {
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

// ------------------------------------
// POST CREATE JOB
// ------------------------------------

app.post("/api/jobs", async (req: Request, res: Response) => {
  try {
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

    // Temporary owner information from frontend headers.
    // Replace with verified identity before production.

    const recruiterId = req.header("x-user-id") || "";
    const ownerEmail = req.header("x-user-email")?.trim().toLowerCase() || "";

    if (!ownerEmail) {
      res.status(401).json({
        success: false,
        message: "Recruiter email is required",
      });
      return;
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
      recruiterId,
      ownerEmail,
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
});

// ------------------------------------
// PATCH UPDATE JOB
// ------------------------------------

app.patch("/api/jobs/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid job ID",
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
      "closed",
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

    if (updateData.status === "draft") {
      updateData.closed = true;
    } else if (updateData.status === "active") {
      updateData.closed = false;
    } else if (updateData.status === "closed") {
      updateData.closed = true;
    }

    if (
      updateData.closed !== undefined &&
      typeof updateData.closed !== "boolean"
    ) {
      res.status(400).json({
        success: false,
        message: "Closed must be true or false",
      });
      return;
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
      { _id: new ObjectId(id) },
      { $set: updateData },
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
});

// ------------------------------------
// DELETE JOB
// ------------------------------------

app.delete("/api/jobs/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid job ID",
      });
      return;
    }

    const jobObjectId = new ObjectId(id);

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
    console.error("DELETE JOB ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete job",
    });
  }
});

// ====================================
// SAVED JOBS APIs
// ====================================

// ------------------------------------
// POST SAVE JOB
// ------------------------------------

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

      if (job.status === "draft" || job.closed === true) {
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

// ------------------------------------
// GET USER SAVED JOBS
// ------------------------------------

app.get(
  "/api/saved-jobs",
  verifyUser,
  verifySeeker,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.authUser!;

      const savedJobs = await savedJobsCollection
        .aggregate([
          {
            $match: {
              userId: user.id,
            },
          },
          {
            $sort: {
              savedAt: -1,
            },
          },
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
              jobId: {
                $toString: "$jobId",
              },
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

// ------------------------------------
// CHECK SAVED JOB
// ------------------------------------

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

// ------------------------------------
// DELETE SAVED JOB
// ------------------------------------

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
// APPLICATION APIs
// ====================================

// ------------------------------------
// CHECK APPLICATION
// ------------------------------------

app.get("/api/applications/check", async (req: Request, res: Response) => {
  try {
    const { jobId, email } = req.query;

    if (
      typeof jobId !== "string" ||
      !ObjectId.isValid(jobId) ||
      typeof email !== "string" ||
      !email.trim()
    ) {
      res.status(400).json({
        success: false,
        message: "Valid job ID and email are required",
      });
      return;
    }

    const existingApplication = await applicationsCollection.findOne({
      jobId: new ObjectId(jobId),
      applicantEmail: email.trim().toLowerCase(),
    });

    res.status(200).json({
      success: true,
      applied: !!existingApplication,
    });
  } catch (error) {
    console.error("CHECK APPLICATION ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to check application",
    });
  }
});

// ------------------------------------
// POST APPLY FOR A JOB
// ------------------------------------

app.post("/api/applications", async (req: Request, res: Response) => {
  try {
    const { jobId, name, email, experience, resumeUrl, coverLetter } = req.body;

    if (
      typeof jobId !== "string" ||
      !ObjectId.isValid(jobId) ||
      typeof name !== "string" ||
      !name.trim() ||
      typeof email !== "string" ||
      !email.trim()
    ) {
      res.status(400).json({
        success: false,
        message: "Job ID, name and email are required",
      });
      return;
    }

    const job = await jobsCollection.findOne({
      _id: new ObjectId(jobId),
    });

    if (!job) {
      res.status(404).json({
        success: false,
        message: "Job not found",
      });
      return;
    }

    if (job.closed === true || job.status === "draft") {
      res.status(400).json({
        success: false,
        message: "This job is no longer accepting applications",
      });
      return;
    }

    const applicantEmail = email.trim().toLowerCase();

    const existingApplication = await applicationsCollection.findOne({
      jobId: new ObjectId(jobId),
      applicantEmail,
    });

    if (existingApplication) {
      res.status(409).json({
        success: false,
        message: "You have already applied for this job",
      });
      return;
    }

    const newApplication = {
      jobId: new ObjectId(jobId),
      jobTitle: String(job.title || ""),
      company: String(job.company || ""),
      recruiterEmail: String(job.ownerEmail || "").toLowerCase(),

      applicantName: name.trim(),
      applicantEmail,

      experience: typeof experience === "string" ? experience.trim() : "",

      resumeUrl: typeof resumeUrl === "string" ? resumeUrl.trim() : "",

      coverLetter: typeof coverLetter === "string" ? coverLetter.trim() : "",

      status: "Applied",
      appliedAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await applicationsCollection.insertOne(newApplication);

    res.status(201).json({
      success: true,
      message: "Application submitted successfully",
      data: {
        _id: result.insertedId,
        ...newApplication,
      },
    });
  } catch (error) {
    console.error("APPLY JOB ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to submit application",
    });
  }
});

// ------------------------------------
// GET RECRUITER APPLICATIONS
// ------------------------------------

app.get("/api/applications/recruiter", async (req: Request, res: Response) => {
  try {
    const recruiterEmail = req.header("x-user-email")?.trim().toLowerCase();

    if (!recruiterEmail) {
      res.status(401).json({
        success: false,
        message: "Recruiter email is required",
      });
      return;
    }

    const recruiterJobs = await jobsCollection
      .find({ ownerEmail: recruiterEmail })
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
});

// ------------------------------------
// GET APPLICANTS FOR A SPECIFIC JOB
// ------------------------------------

app.get(
  "/api/applications/recruiter/:jobId",
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;

      const recruiterEmail = req.header("x-user-email")?.trim().toLowerCase();

      if (!recruiterEmail) {
        res.status(401).json({
          success: false,
          message: "Recruiter email is required",
        });
        return;
      }

      if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
        res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
        return;
      }

      const job = await jobsCollection.findOne({
        _id: new ObjectId(jobId),
        ownerEmail: recruiterEmail,
      });

      if (!job) {
        res.status(404).json({
          success: false,
          message: "Job not found or you do not have permission to view it",
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

// ------------------------------------
// PATCH APPLICATION STATUS
// ------------------------------------

app.patch(
  "/api/applications/:id/status",
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;

      const recruiterEmail = req.header("x-user-email")?.trim().toLowerCase();

      const allowedStatuses = [
        "Applied",
        "Under Review",
        "Shortlisted",
        "Offered",
        "Rejected",
      ];

      const { status } = req.body;

      if (typeof id !== "string" || !ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          message: "Invalid application ID",
        });
        return;
      }

      if (!recruiterEmail) {
        res.status(401).json({
          success: false,
          message: "Recruiter email is required",
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
        ownerEmail: recruiterEmail,
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

// ------------------------------------
// ERROR HANDLER
// ------------------------------------

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

// ------------------------------------
// START SERVER
// ------------------------------------

const startServer = async () => {
  try {
    const db = await connectDB();

    jobsCollection = db.collection("jobs");
    applicationsCollection = db.collection("applications");
    savedJobsCollection = db.collection("savedJobs");

    await savedJobsCollection.createIndex(
      { jobId: 1, userId: 1 },
      { unique: true },
    );

    await savedJobsCollection.createIndex({
      userId: 1,
      savedAt: -1,
    });

    console.log("MongoDB collections connected successfully");
    console.log("Saved Jobs indexes created successfully");

    app.listen(PORT, () => {
      console.log(`HireLoop server running on port ${PORT}`);
      console.log("Allowed frontend origins:", allowedOrigins);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
};

startServer();
