export default { server: { port: 5299, strictPort: true, configureServer(s) { console.log("USER-CONFIGURE-SERVER-RAN"); s.middlewares.use("/api/test", (req,res)=>res.end("hit")); } } }
