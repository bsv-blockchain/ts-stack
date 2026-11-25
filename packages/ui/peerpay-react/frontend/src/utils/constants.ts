interface Constants {
  messageboxURL: string
}

let constants: Constants

if (
  window.location.host.startsWith("localhost")
  || window.location.host.startsWith("staging")
) {
  // Local / Staging environment
  constants = {
    messageboxURL: 'https://messagebox.babbage.systems' // NO STAGING URL CURRENTLY: https://staging-messagebox.babbage.systems
  }
} else {
  // Production environment
  constants = {
    messageboxURL: 'https://messagebox.babbage.systems'
  }
}

export default constants
