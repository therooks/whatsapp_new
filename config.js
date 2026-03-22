import dotenv from "dotenv";
dotenv.config();

export default {
  PORT: process.env.PORT || 5000,
  BACKEND_URL: process.env.BACKEND_URL || "http://127.0.0.1:82", // your CI3 base URL
  DB_HOST: process.env.DB_HOST || "srv921.hstgr.io",
  DB_USER: process.env.DB_USER || "u304756050_whatsapp_serve",
  DB_PASS: process.env.DB_PASS || "Amazone@deal007",
  DB_NAME: process.env.DB_NAME || "u304756050_whatsapp_serve",
  DB_PORT: process.env.DB_PORT || 3306,
};
