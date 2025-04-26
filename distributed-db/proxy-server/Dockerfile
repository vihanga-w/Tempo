FROM node:22.14.0-slim

WORKDIR /proxy

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src

RUN npm run build

EXPOSE 2276

CMD ["npm", "start"]
