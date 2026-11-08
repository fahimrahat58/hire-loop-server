import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ObjectId, type Collection, type Document } from "mongodb";
import { connectDB } from "./config/db.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

let jobsCollection: Collection<Document>;

// Home API
app.get("/", (req, res) => {
  res.send("HireLoop Server Running");
});

// GET All Jobs
app.get("/api/jobs", async (req: Request, res: Response) => {
  try {
    const jobs = await jobsCollection.find().sort({ createdAt: -1 }).toArray();

    res.status(200).json({
      success: true,
      data: jobs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch jobs",
    });
  }
});

// GET Single Job
app.get("/api/jobs/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
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
    res.status(500).json({
      success: false,
      message: "Failed to fetch job",
    });
  }
});

// POST Create Job
app.post("/api/jobs", async (req: Request, res: Response) => {
  try {
    const { title, company, location, salary, category, description } =
      req.body;

    if (!title || !company || !location) {
      res.status(400).json({
        success: false,
        message: "Title, company and location are required",
      });
      return;
    }

    const newJob = {
      title,
      company,
      location,
      salary: salary || "",
      category: category || "",
      description: description || "",
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
    res.status(500).json({
      success: false,
      message: "Failed to create job",
    });
  }
});

// PATCH Update Job
app.patch("/api/jobs/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
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
    ];

    const updateData: Document = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
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
    res.status(500).json({
      success: false,
      message: "Failed to update job",
    });
  }
});

// DELETE Job
app.delete("/api/jobs/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
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
    res.status(500).json({
      success: false,
      message: "Failed to delete job",
    });
  }
});

// Start Server
const startServer = async () => {
  try {
    const db = await connectDB();

    jobsCollection = db.collection("jobs");

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
};

startServer();
