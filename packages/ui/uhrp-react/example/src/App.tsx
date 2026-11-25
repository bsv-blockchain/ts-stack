import React from 'react'
import { Img, Source } from '@bsv/uhrp-react'
import './App.css'

const App: React.FC = () => {
  return (
    <div className="container">
      <h1 className="heading">UHRP React Example</h1>

      <div className="content">
        <div className="media-container">
          <h2 className="subheading">Image Preview</h2>
          <Img
            src="XUUVZqvzYskUvVfBZsrqXsvyoAUojQcJxDr6hTUwEz1vPLdvc64z"
            className="image"
            alt="Example Image"
          />
        </div>

        <div className="media-container">
          <h2 className="subheading">Video Preview</h2>
          <video controls className="video">
            <Source src="XUTEGfCykZ4E8oJhT98keoPTg2Q28Nq4sJJXLf9CYA5CjV7ZsTCV" />
          </video>
        </div>
      </div>
    </div>
  )
}

export default App
