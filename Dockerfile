# Build the Vite frontend; tsx remains available at runtime because the API
# currently starts directly from TypeScript sources via `npm start`.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Keep the runtime image focused on server code and built frontend assets.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    API_PORT=3001

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist

EXPOSE 3001
CMD ["npm", "start"]
