import { useState, useEffect, useRef } from 'react'
import type {
  AcquireCertificateArgs,
  AcquireCertificateResult,
  CertificateResult,
  ProveCertificateResult
} from '@bsv/sdk'
import {
  Box,
  Typography,
  Paper,
  Stack,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  List,
  ListItem,
  ListItemText,
  Pagination,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  IconButton,
  Grid
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import AddIcon from '@mui/icons-material/Add'
import { useWallet } from '../contexts/WalletContext'

/**
 * Some "field" interface for the "acquireCertificate" direct mode fields.
 * We'll store them in state as the user enters them.
 */
interface DirectModeFields {
  serialNumber: string
  revocationOutpoint: string
  signature: string
  keyringRevealer: string
  keyringForSubject: Array<{ formKey: number; fieldName: string; fieldValue: string }>
}

interface IssuanceModeFields {
  certifierUrl: string
}

interface FieldPair {
  formKey: number
  name: string
  value: string
}

function populatedValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''))
}

function directCertificateArgs({
  serialNumber,
  revocationOutpoint,
  signature,
  keyringRevealer,
  keyringForSubject
}: DirectModeFields): Partial<AcquireCertificateArgs> {
  const fields = populatedValues({
    serialNumber: serialNumber.trim(),
    revocationOutpoint: revocationOutpoint.trim(),
    signature: signature.trim(),
    keyringRevealer: keyringRevealer.trim()
  })
  const keyring = Object.fromEntries(
    keyringForSubject
      .filter(pair => pair.fieldName.trim() !== '')
      .map(pair => [pair.fieldName.trim(), btoa(pair.fieldValue.trim())])
  )
  return Object.keys(keyring).length ? { ...fields, keyringForSubject: keyring } : fields
}

function CertificatesPage() {
  const { wallet } = useWallet()
  const nextFormKey = useRef(0)

  /************************************************
   * listCertificates filters & pagination
   ************************************************/
  const [certifierList, setCertifierList] = useState('')
  const [typeList, setTypeList] = useState('')
  const [limit, setLimit] = useState(5)
  const [page, setPage] = useState(1)

  const [certs, setCerts] = useState<CertificateResult[]>([])
  const [totalCerts, setTotalCerts] = useState(0)
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState('')

  /************************************************
   * Acquire Certificate Modal
   ************************************************/
  const [acquireModalOpen, setAcquireModalOpen] = useState(false)
  const [acqProtocol, setAcqProtocol] = useState<'direct' | 'issuance'>('direct')
  const [acqType, setAcqType] = useState('')
  const [acqCertifier, setAcqCertifier] = useState('')
  const [fields, setFields] = useState<FieldPair[]>([]) // user-friendly approach for "fields"
  const [directModeFields, setDirectModeFields] = useState<DirectModeFields>({
    serialNumber: '',
    revocationOutpoint: '',
    signature: '',
    keyringRevealer: '',
    keyringForSubject: []
  })
  const [issuanceModeFields, setIssuanceModeFields] = useState<IssuanceModeFields>({
    certifierUrl: ''
  })
  const [acquireLoading, setAcquireLoading] = useState(false)
  const [acquireError, setAcquireError] = useState('')
  const [acquireResult, setAcquireResult] = useState<AcquireCertificateResult | null>(null)

  /************************************************
   * Prove flow
   ************************************************/
  const [proveDialogOpen, setProveDialogOpen] = useState(false)
  const [fieldsToReveal, setFieldsToReveal] = useState<FieldPair[]>([])
  const [verifierPubKey, setVerifierPubKey] = useState('')
  const [proveLoading, setProveLoading] = useState(false)
  const [proveError, setProveError] = useState('')
  const [proveResult, setProveResult] = useState<ProveCertificateResult | null>(null)
  const [selectedCert, setSelectedCert] = useState<CertificateResult | null>(null)

  /************************************************
   * Relinquish confirm
   ************************************************/
  const [confirmRelinquishOpen, setConfirmRelinquishOpen] = useState(false)
  const [certToRelinquish, setCertToRelinquish] = useState<CertificateResult | null>(null)
  const [relinquishLoading, setRelinquishLoading] = useState(false)
  const [relinquishError, setRelinquishError] = useState('')

  /************************************************
   * useEffect: load on mount or when filters change
   ************************************************/
  useEffect(() => {
    if (!wallet) return
    void listCertificates(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet])

  /************************************************
   * listCertificates
   ************************************************/
  async function listCertificates(currentPage: number) {
    if (!wallet) return
    setLoadingList(true)
    setListError('')
    try {
      const certifiersArr = certifierList
        ? certifierList
            .split(',')
            .map(x => x.trim())
            .filter(Boolean)
        : []
      const typeArr = typeList
        ? typeList
            .split(',')
            .map(x => x.trim())
            .filter(Boolean)
        : []

      const resp = await wallet.listCertificates({
        certifiers: certifiersArr,
        types: typeArr,
        limit,
        offset: (currentPage - 1) * limit
      })
      setCerts(resp.certificates || [])
      setTotalCerts(resp.totalCertificates || 0)
    } catch (err: any) {
      setListError(err?.message || String(err))
    } finally {
      setLoadingList(false)
    }
  }

  function handleApplyFilters() {
    setPage(1)
    void listCertificates(1)
  }

  /************************************************
   * Acquire Certificate Flow
   ************************************************/
  function openAcquireModal() {
    setAcquireModalOpen(true)
    setAcqProtocol('direct')
    setAcqType('')
    setAcqCertifier('')
    setFields([])
    setDirectModeFields({
      serialNumber: '',
      revocationOutpoint: '',
      signature: '',
      keyringRevealer: '',
      keyringForSubject: []
    })
    setIssuanceModeFields({ certifierUrl: '' })
    setAcquireError('')
    setAcquireResult(null)
  }

  function closeAcquireModal() {
    setAcquireModalOpen(false)
  }

  function addFieldPair() {
    const formKey = nextFormKey.current++
    setFields(prev => [...prev, { formKey, name: '', value: '' }])
  }

  function addKeyringPair() {
    const formKey = nextFormKey.current++
    setDirectModeFields(prev => ({
      ...prev,
      keyringForSubject: [...prev.keyringForSubject, { formKey, fieldName: '', fieldValue: '' }]
    }))
  }

  function removeKeyringPair(idx: number) {
    setDirectModeFields(prev => ({
      ...prev,
      keyringForSubject: prev.keyringForSubject.filter((_, i) => i !== idx)
    }))
  }

  async function handleAcquireCertificate() {
    if (!wallet) return
    setAcquireLoading(true)
    setAcquireError('')
    setAcquireResult(null)
    try {
      const fieldsObj = Object.fromEntries(
        fields
          .filter(field => field.name.trim() !== '')
          .map(field => [field.name.trim(), field.value.trim()])
      )
      const args: AcquireCertificateArgs = {
        type: acqType.trim(),
        certifier: acqCertifier.trim(),
        acquisitionProtocol: acqProtocol,
        fields: fieldsObj
      }
      const certifierUrl = issuanceModeFields.certifierUrl.trim()
      if (acqProtocol === 'direct') {
        Object.assign(args, directCertificateArgs(directModeFields))
      } else if (certifierUrl) {
        args.certifierUrl = certifierUrl
      }

      const resp = await wallet.acquireCertificate(args)
      setAcquireResult(resp)

      // Optionally refresh list
      void listCertificates(page)
    } catch (err: any) {
      setAcquireError(err?.message || String(err))
    } finally {
      setAcquireLoading(false)
    }
  }

  /************************************************
   * Prove flow
   ************************************************/
  function openProveDialog(cert: CertificateResult) {
    setSelectedCert(cert)
    setProveDialogOpen(true)
    setFieldsToReveal([])
    setVerifierPubKey('')
    setProveError('')
    setProveResult(null)
  }
  function closeProveDialog() {
    setProveDialogOpen(false)
    setSelectedCert(null)
  }

  function addRevealField() {
    const formKey = nextFormKey.current++
    setFieldsToReveal(prev => [...prev, { formKey, name: '', value: '' }])
  }
  function removeRevealField(idx: number) {
    setFieldsToReveal(prev => prev.filter((_, i) => i !== idx))
  }

  async function handleProveCertificate() {
    if (!wallet || !selectedCert) return
    setProveLoading(true)
    setProveError('')
    setProveResult(null)
    try {
      // Convert fieldsToReveal to an array of field names
      const revealNames = fieldsToReveal.map(f => f.name.trim()).filter(Boolean)
      if (!revealNames.length) {
        throw new Error('No fields to reveal specified.')
      }

      const resp = await wallet.proveCertificate({
        certificate: selectedCert,
        fieldsToReveal: revealNames,
        verifier: verifierPubKey.trim()
      })
      setProveResult(resp)
    } catch (err: any) {
      setProveError(err?.message || String(err))
    } finally {
      setProveLoading(false)
    }
  }

  /************************************************
   * Relinquish flow
   ************************************************/
  function confirmRelinquish(cert: CertificateResult) {
    setCertToRelinquish(cert)
    setRelinquishError('')
    setConfirmRelinquishOpen(true)
  }
  function closeConfirmRelinquish() {
    setConfirmRelinquishOpen(false)
    setCertToRelinquish(null)
  }

  async function doRelinquish() {
    if (!wallet || !certToRelinquish) return
    setRelinquishLoading(true)
    setRelinquishError('')
    try {
      await wallet.relinquishCertificate({
        type: certToRelinquish.type,
        serialNumber: certToRelinquish.serialNumber,
        certifier: certToRelinquish.certifier
      })
      closeConfirmRelinquish()
      // refresh
      void listCertificates(page)
    } catch (err: any) {
      setRelinquishError(err?.message || String(err))
    } finally {
      setRelinquishLoading(false)
    }
  }

  /************************************************
   * Render
   ************************************************/
  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h4">Certificates</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAcquireModal}>
          Acquire Certificate
        </Button>
      </Stack>

      {/* FILTER & LIST panel */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1">Filters</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 2 }}>
          <TextField
            label="Certifiers (comma-separated hex pubkeys)"
            value={certifierList}
            onChange={e => setCertifierList(e.target.value)}
          />
          <TextField
            label="Types (comma-separated base64 strings)"
            value={typeList}
            onChange={e => setTypeList(e.target.value)}
          />
          <FormControl size="small" sx={{ width: 100 }}>
            <InputLabel>Limit</InputLabel>
            <Select
              label="Limit"
              value={limit}
              onChange={e => {
                setLimit(Number(e.target.value))
                setPage(1)
              }}
            >
              <MenuItem value={5}>5</MenuItem>
              <MenuItem value={10}>10</MenuItem>
              <MenuItem value={25}>25</MenuItem>
            </Select>
          </FormControl>
          <Button variant="outlined" onClick={handleApplyFilters}>
            Apply
          </Button>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        {loadingList && <Typography>Loading...</Typography>}
        {listError && <Alert severity="error">{listError}</Alert>}
        {!loadingList && !listError && certs.length === 0 && (
          <Typography>No certificates found.</Typography>
        )}
        <List>
          {certs.map(c => (
            <ListItem
              key={JSON.stringify([c.certifier, c.type, c.subject, c.serialNumber])}
              sx={{ borderBottom: '1px solid #eee', display: 'block' }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <ListItemText
                  primary={`Serial: ${c.serialNumber} – Type: ${c.type} – Certifier: ${c.certifier}`}
                  secondary={
                    <>
                      Subject: {c.subject} <br />
                      RevocationOutpoint: {c.revocationOutpoint} <br />
                      Signature: {c.signature} <br />
                      Fields: {JSON.stringify(c.fields)}
                    </>
                  }
                />
                <Stack direction="row" spacing={1}>
                  <Button variant="outlined" onClick={() => openProveDialog(c)}>
                    Prove
                  </Button>
                  <IconButton color="warning" onClick={() => confirmRelinquish(c)}>
                    <DeleteIcon />
                  </IconButton>
                </Stack>
              </Box>
            </ListItem>
          ))}
        </List>
        {certs.length > 0 && (
          <Pagination
            sx={{ mt: 2 }}
            page={page}
            count={Math.ceil(totalCerts / limit)}
            onChange={(_, val) => {
              setPage(val)
              void listCertificates(val)
            }}
          />
        )}
      </Paper>

      {/******************************************
       * Acquire Certificate Modal
       ******************************************/}
      <Dialog open={acquireModalOpen} onClose={closeAcquireModal} maxWidth="md" fullWidth>
        <DialogTitle>Acquire Certificate</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {acquireError && <Alert severity="error">{acquireError}</Alert>}
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Certificate Type (base64)"
                value={acqType}
                onChange={e => setAcqType(e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Certifier PubKey"
                value={acqCertifier}
                onChange={e => setAcqCertifier(e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <FormControl fullWidth>
                <InputLabel>Acquisition Protocol</InputLabel>
                <Select
                  label="Acquisition Protocol"
                  value={acqProtocol}
                  onChange={e =>
                    setAcqProtocol(e.target.value === 'issuance' ? 'issuance' : 'direct')
                  }
                >
                  <MenuItem value="direct">direct</MenuItem>
                  <MenuItem value="issuance">issuance</MenuItem>
                </Select>
              </FormControl>
            </Grid>
          </Grid>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            Fields
          </Typography>
          <Stack spacing={1} sx={{ mb: 2 }}>
            {fields.map((f, idx) => (
              <Stack direction="row" spacing={1} key={f.formKey}>
                <TextField
                  label="Field Name"
                  value={f.name}
                  onChange={e => {
                    const val = e.target.value
                    setFields(prev => {
                      const newArr = [...prev]
                      newArr[idx] = { ...newArr[idx], name: val }
                      return newArr
                    })
                  }}
                  size="small"
                />
                <TextField
                  label="Field Value"
                  value={f.value}
                  onChange={e => {
                    const val = e.target.value
                    setFields(prev => {
                      const newArr = [...prev]
                      newArr[idx] = { ...newArr[idx], value: val }
                      return newArr
                    })
                  }}
                  size="small"
                />
                <IconButton
                  color="warning"
                  onClick={() => {
                    setFields(prev => prev.filter((_, i) => i !== idx))
                  }}
                >
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button variant="outlined" size="small" onClick={addFieldPair} startIcon={<AddIcon />}>
              Add Field
            </Button>
          </Stack>

          {acqProtocol === 'direct' ? (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2">Direct Mode Extra Fields</Typography>
              <Stack spacing={2} sx={{ mt: 1 }}>
                <TextField
                  label="Serial Number"
                  value={directModeFields.serialNumber}
                  onChange={e =>
                    setDirectModeFields(prev => ({
                      ...prev,
                      serialNumber: e.target.value
                    }))
                  }
                />
                <TextField
                  label="Revocation Outpoint"
                  value={directModeFields.revocationOutpoint}
                  onChange={e =>
                    setDirectModeFields(prev => ({
                      ...prev,
                      revocationOutpoint: e.target.value
                    }))
                  }
                />
                <TextField
                  label="Signature"
                  value={directModeFields.signature}
                  onChange={e =>
                    setDirectModeFields(prev => ({
                      ...prev,
                      signature: e.target.value
                    }))
                  }
                />
                <TextField
                  label="Keyring Revealer"
                  helperText='PubKey or "certifier"'
                  value={directModeFields.keyringRevealer}
                  onChange={e =>
                    setDirectModeFields(prev => ({
                      ...prev,
                      keyringRevealer: e.target.value
                    }))
                  }
                />
                <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                  Keyring For Subject
                </Typography>
                {directModeFields.keyringForSubject.map((k, idx) => (
                  <Stack direction="row" spacing={1} key={k.formKey} sx={{ mb: 1 }}>
                    <TextField
                      label="Field Name"
                      value={k.fieldName}
                      onChange={e => {
                        const val = e.target.value
                        setDirectModeFields(prev => {
                          const newArr = [...prev.keyringForSubject]
                          newArr[idx] = { ...newArr[idx], fieldName: val }
                          return { ...prev, keyringForSubject: newArr }
                        })
                      }}
                      size="small"
                    />
                    <TextField
                      label="Field Value"
                      value={k.fieldValue}
                      onChange={e => {
                        const val = e.target.value
                        setDirectModeFields(prev => {
                          const newArr = [...prev.keyringForSubject]
                          newArr[idx] = { ...newArr[idx], fieldValue: val }
                          return { ...prev, keyringForSubject: newArr }
                        })
                      }}
                      size="small"
                    />
                    <IconButton color="warning" onClick={() => removeKeyringPair(idx)}>
                      <DeleteIcon />
                    </IconButton>
                  </Stack>
                ))}
                <Button variant="outlined" size="small" onClick={addKeyringPair}>
                  Add Keyring Field
                </Button>
              </Stack>
            </Box>
          ) : (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2">Issuance Mode Extra Fields</Typography>
              <Stack spacing={2} sx={{ mt: 1 }}>
                <TextField
                  label="Certifier URL"
                  value={issuanceModeFields.certifierUrl}
                  onChange={e =>
                    setIssuanceModeFields(prev => ({
                      ...prev,
                      certifierUrl: e.target.value
                    }))
                  }
                />
              </Stack>
            </Box>
          )}

          {acquireResult && (
            <Box
              sx={{
                mt: 2,
                background: '#f5f5f5',
                p: 1,
                maxHeight: 300,
                overflow: 'auto'
              }}
            >
              <Typography variant="subtitle2">Result</Typography>
              <pre style={{ margin: 0 }}>{JSON.stringify(acquireResult, null, 2)}</pre>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAcquireModal} disabled={acquireLoading}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleAcquireCertificate} disabled={acquireLoading}>
            {acquireLoading ? 'Acquiring...' : 'Acquire'}
          </Button>
        </DialogActions>
      </Dialog>

      {/******************************************
       * Prove Certificate Dialog
       ******************************************/}
      <Dialog open={proveDialogOpen} onClose={closeProveDialog} maxWidth="md" fullWidth>
        <DialogTitle>Prove Certificate Fields</DialogTitle>
        <DialogContent>
          {proveError && <Alert severity="error">{proveError}</Alert>}
          <Box sx={{ mt: 2 }}>
            <TextField
              label="Verifier PubKey"
              value={verifierPubKey}
              onChange={e => setVerifierPubKey(e.target.value)}
              fullWidth
            />
          </Box>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            Fields To Reveal
          </Typography>
          <Stack spacing={1} sx={{ mb: 1 }}>
            {fieldsToReveal.map((f, idx) => (
              <Stack direction="row" spacing={1} key={f.formKey}>
                <TextField
                  label="Field Name"
                  size="small"
                  value={f.name}
                  onChange={e => {
                    const val = e.target.value
                    setFieldsToReveal(prev => {
                      const newArr = [...prev]
                      newArr[idx] = { ...newArr[idx], name: val }
                      return newArr
                    })
                  }}
                />
                <IconButton color="warning" onClick={() => removeRevealField(idx)}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button variant="outlined" size="small" onClick={addRevealField}>
              Add Field
            </Button>
          </Stack>
          {proveResult && (
            <Box
              sx={{
                background: '#f5f5f5',
                p: 1,
                maxHeight: 300,
                overflow: 'auto'
              }}
            >
              <Typography variant="subtitle2">Prove Result</Typography>
              <pre style={{ margin: 0 }}>{JSON.stringify(proveResult, null, 2)}</pre>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeProveDialog} disabled={proveLoading}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleProveCertificate} disabled={proveLoading}>
            {proveLoading ? 'Proving...' : 'Prove'}
          </Button>
        </DialogActions>
      </Dialog>

      {/******************************************
       * Confirm Relinquish
       ******************************************/}
      <Dialog open={confirmRelinquishOpen} onClose={closeConfirmRelinquish}>
        <DialogTitle>Relinquish Certificate</DialogTitle>
        <DialogContent>
          {relinquishError && <Alert severity="error">{relinquishError}</Alert>}
          <Typography>Are you sure you want to relinquish this certificate?</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeConfirmRelinquish} disabled={relinquishLoading}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={doRelinquish}
            disabled={relinquishLoading}
          >
            {relinquishLoading ? 'Relinquishing...' : 'Relinquish'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default CertificatesPage
