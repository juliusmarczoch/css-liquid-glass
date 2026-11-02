# Static build of the demo, served by an unprivileged nginx under
# /study/001-liquid-glass/ (deploy/nginx.conf). Used by the deploy workflow.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -- --base=/study/001-liquid-glass/

FROM nginxinc/nginx-unprivileged:1.27-alpine
# Links the image on GHCR to this repository.
LABEL org.opencontainers.image.source="https://github.com/nordify/css-liquid-glass"
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html/study/001-liquid-glass
