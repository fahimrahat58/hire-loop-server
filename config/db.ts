import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI!;
const dbName = process.env.DB_NAME!;

const client = new MongoClient(uri);

export const connectDB = async () => {
  try {
    await client.connect();

    console.log("MongoDB Connected Successfully");

    return client.db(dbName);
  } catch (error) {
    console.error("MongoDB Connection Failed:", error);
    process.exit(1);
  }
};