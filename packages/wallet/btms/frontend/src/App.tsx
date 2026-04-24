// frontend/src/App.tsx
import React from 'react'
import { Switch, Route } from 'react-router-dom'

import Home from './pages/Home'
import Mint from './pages/Mint'
import Tokens from './pages/Tokens'

const App: React.FC = () => {
  return (
    <Switch>
      <Route exact path="/" render={props => <Home {...props} />} />
      <Route exact path="/mint" render={props => <Mint {...props} />} />
      <Route exact path="/tokens" render={() => <Tokens />} />
      <Route path="/tokens/:assetId" render={() => <Tokens />} />
      <Route render={props => <Home {...props} />} />
    </Switch>
  )
}

export default App
