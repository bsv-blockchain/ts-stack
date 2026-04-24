import { describe, it, expect } from '@jest/globals'
import makeUserInterface, { type UIConfig } from '../makeUserInterface.js'

describe('makeUserInterface', () => {
  describe('default configuration', () => {
    it('should generate HTML with default values', () => {
      const html = makeUserInterface()

      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('<title>Overlay Services</title>')
      expect(html).toContain('https://bsvblockchain.org/favicon.ico')
      expect(html).toContain('--background-color: #191919')
      expect(html).toContain('--primary-color: #3b6efb')
    })

    it('should include necessary scripts', () => {
      const html = makeUserInterface()

      expect(html).toContain('showdown')
      expect(html).toContain('highlight.min.js')
    })

    it('should include main UI structure', () => {
      const html = makeUserInterface()

      expect(html).toContain('class="main"')
      expect(html).toContain('class="column_left"')
      expect(html).toContain('class="column_right"')
      expect(html).toContain('id="manager_list"')
      expect(html).toContain('id="provider_list"')
      expect(html).toContain('id="external_list"')
    })

    it('should include external links', () => {
      const html = makeUserInterface()

      expect(html).toContain('https://github.com/bsv-blockchain/overlay-services')
      expect(html).toContain('https://bsv.brc.dev/transactions/0076')
      expect(html).toContain('https://fast.brc.dev')
    })
  })

  describe('custom configuration', () => {
    it('should use custom host', () => {
      const config: UIConfig = {
        host: 'https://custom-host.com'
      }
      const html = makeUserInterface(config)

      // HOST is set as a JS variable; URLs are built at runtime in the browser
      expect(html).toContain("const HOST = 'https://custom-host.com'")
      expect(html).toContain("HOST + '/listTopicManagers'")
      expect(html).toContain('/getDocumentationForTopicManager')
    })

    it('should use custom favicon URL', () => {
      const config: UIConfig = {
        faviconUrl: 'https://example.com/favicon.ico'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('https://example.com/favicon.ico')
      expect(html).toContain('const faviconUrl = \'https://example.com/favicon.ico\'')
    })

    it('should use custom colors', () => {
      const config: UIConfig = {
        backgroundColor: '#000000',
        primaryColor: '#ff0000',
        secondaryColor: '#00ff00',
        primaryTextColor: '#ffffff'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('--background-color: #000000')
      expect(html).toContain('--primary-color: #ff0000')
      expect(html).toContain('--secondary-color: #00ff00')
      expect(html).toContain('--primary-text-color: #ffffff')
    })

    it('should use custom fonts', () => {
      const config: UIConfig = {
        fontFamily: 'Comic Sans MS, cursive',
        headingFontFamily: 'Impact, fantasy'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('--font-family: Comic Sans MS, cursive')
      expect(html).toContain('--heading-font-family: Impact, fantasy')
    })

    it('should include additional styles', () => {
      const config: UIConfig = {
        additionalStyles: '.custom-class { color: red; }'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('.custom-class { color: red; }')
    })

    it('should use custom section background color', () => {
      const config: UIConfig = {
        sectionBackgroundColor: '#123456'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('--section-background-color: #123456')
    })

    it('should use custom link and hover colors', () => {
      const config: UIConfig = {
        linkColor: '#ff00ff',
        hoverColor: '#00ffff'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('--link-color: #ff00ff')
      expect(html).toContain('--hover-color: #00ffff')
    })

    it('should use custom border color', () => {
      const config: UIConfig = {
        borderColor: '#abcdef'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('--border-color: #abcdef')
    })

    it('should use custom secondary background and text colors', () => {
      const config: UIConfig = {
        secondaryBackgroundColor: '#f0f0f0',
        secondaryTextColor: '#111111'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('--secondary-background-color: #f0f0f0')
      expect(html).toContain('--secondary-text-color: #111111')
    })

    it('should use custom default content', () => {
      const config: UIConfig = {
        defaultContent: '`"# Custom Content\\n\\nThis is custom."`'
      }
      const html = makeUserInterface(config)

      expect(html).toContain('# Custom Content')
      expect(html).toContain('This is custom.')
    })
  })

  describe('responsive design', () => {
    it('should include responsive media queries', () => {
      const html = makeUserInterface()

      expect(html).toContain('@media screen and (max-width: 850px)')
    })
  })

  describe('JavaScript functions', () => {
    it('should include returnHome function', () => {
      const html = makeUserInterface()

      expect(html).toContain('window.returnHome')
    })

    it('should include managerDocumentation function', () => {
      const html = makeUserInterface()

      expect(html).toContain('window.managerDocumentation')
    })

    it('should include topicDocumentation function', () => {
      const html = makeUserInterface()

      expect(html).toContain('window.topicDocumentation')
    })

    it('should include syntax highlighting setup', () => {
      const html = makeUserInterface()

      expect(html).toContain('window.hljs')
      expect(html).toContain('applyHighlighting')
    })

    it('should include URL hash handling', () => {
      const html = makeUserInterface()

      expect(html).toContain('handleUrlHash')
      expect(html).toContain('window.location.hash')
    })
  })
})
