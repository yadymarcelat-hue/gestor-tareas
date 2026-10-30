/** @type {import('next').NextConfig} */
module.exports = {
  async rewrites() {
    return [
      { source: "/", destination: "/app.html" },
      { source: "/login", destination: "/login.html" },
      { source: "/aceptar", destination: "/aceptar.html" },
    ];
  },
};
