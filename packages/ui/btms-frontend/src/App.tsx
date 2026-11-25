// frontend/src/App.tsx
import React from 'react'
import { Routes, Route } from 'react-router-dom'

import Home from './pages/Home'
import Mint from './pages/Mint'
import Tokens from './pages/Tokens'

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/mint" element={<Mint />} />
      <Route path="/tokens" element={<Tokens />} />
      <Route path="/tokens/:assetId" element={<Tokens />} />
      <Route path="*" element={<Home />} />
    </Routes>
  )
}

export default App
