import { app, initializeApp } from "../index.ts";

let ready: Promise<void> | null = null;

const ensureReady = () => {
  if (!ready) {
    ready = initializeApp().catch((error) => {
      ready = null;
      throw error;
    });
  }

  return ready;
};

export default async function handler(req: any, res: any) {
  try {
    await ensureReady();
    return app(req, res);
  } catch (error) {
    console.error("API INITIALIZATION FAILED:", error);

    return res.status(500).json({
      success: false,
      message: "Server initialization failed",
    });
  }
}
