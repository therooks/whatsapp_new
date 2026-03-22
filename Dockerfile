# ==========================================================
# 🧱 Base Image — Node version same as your local setup
FROM node:22.17.0-alpine

# ==========================================================
# 🛠️ Install Git & basic tools (required for Baileys)
RUN apk add --no-cache git bash

# ==========================================================
# 📁 Set working directory
WORKDIR /usr/src/app

# ==========================================================
# 📦 Copy dependency files and install
COPY package*.json ./
RUN npm install --omit=dev

# ==========================================================
# 📄 Copy remaining project files
COPY . .

# ==========================================================
# 🌍 Environment setup
ENV NODE_ENV=production
ENV PORT=5000

# ==========================================================
# 🔥 Expose port
EXPOSE 5000

# ==========================================================
# 🚀 Start the app
CMD ["npm", "start"]
