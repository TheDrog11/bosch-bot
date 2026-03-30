FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY index.js ./
EXPOSE 3000
CMD ["node", "index.js"]
