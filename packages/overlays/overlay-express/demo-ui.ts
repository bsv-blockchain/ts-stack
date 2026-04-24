import express from 'express'
import makeUserInterface from './dist/esm/src/makeUserInterface.js'

const main = async () => {

    // We'll make a new server for our overlay node.
    const server = express()

    server.get('/', (req, res) => {
        res.send(makeUserInterface({ host: 'http://localhost:8080' }))
    })
    
    // Decide what port you want the server to listen on.
    server.listen(8081)

    console.log('Overlay Express demo UI started on http://localhost:8081')
}

// Happy hacking :)
main()