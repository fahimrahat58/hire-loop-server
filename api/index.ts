import app, { initializeApp } from "../index.js";

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
  await ensureReady();
  return app(req, res);
}
