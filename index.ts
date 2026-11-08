import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ObjectId, type Collection, type Document } from "mongodb";
import { connectDB } from "./config/db.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ------------------------------------
// CORS CONFIGURATION
// ------------------------------------

const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter((origin): origin is string => Boolean(origin));

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

    res.status(200).json({
      success: true,
      data: jobs,
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
// GET SINGLE JOB
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

    res.status(200).json({
      success: true,
      data: job,
    });
  } catch (error) {
    console.error("GET SINGLE JOB ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch job",
    });
  }
});

// ------------------------------------
// POST CREATE JOB
// ------------------------------------

app.post("/api/jobs", async (req: Request, res: Response) => {
  try {
    const { title, company, location, salary, category, description } =
      req.body;

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

    // Temporary owner information from frontend headers.
    // Use verified JWT/session identity before production.
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
      salary: salary || "",
      category: category || "",
      description: description || "",

      recruiterId,
      ownerEmail,

      closed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await jobsCollection.insertOne(newJob);

    res.status(201).json({
      success: true,
      message: "Job created successfully",
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
      "closed",
    ];

    const updateData: Document = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
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

    res.status(200).json({
      success: true,
      message: "Job updated successfully",
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

    const result = await jobsCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      res.status(404).json({
        success: false,
        message: "Job not found",
      });
      return;
    }

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
// APPLICATION APIs
// ====================================

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

    if (job.closed === true) {
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

    // Find jobs owned by this recruiter.
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

    // Find applications for those jobs.
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

      // Confirm that this application belongs to a job owned by recruiter.
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

    console.log("MongoDB collections connected successfully");

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
