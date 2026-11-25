import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Textarea } from "@/components/ui/textarea"
import { Plus, X, ChevronDown } from "lucide-react"
import {
  CertificateDefinitionData,
  CertificateFieldDescriptor,
  DefinitionData,
  DefinitionType,
  ProtocolDefinitionData,
  SecurityLevel,
  WalletProtocol,
} from "@bsv/sdk"

interface RegistryFormProps {
  type: DefinitionType
  open: boolean
  onClose: () => void
  onSubmit: (data: DefinitionData) => void
  existingData?: DefinitionData
  isSubmitting?: boolean
}

interface CertField {
  key: string
  value: CertificateFieldDescriptor
  isExpanded?: boolean
}

export const RegistryForm = ({
  type,
  open,
  onClose,
  onSubmit,
  existingData,
  isSubmitting = false,
}: RegistryFormProps) => {
  const isEditMode = !!existingData;
  const getInitialFormData = useCallback((): DefinitionData => {
    const baseData = {
      name: "",
      description: "",
      iconURL: "",
      documentationURL: "",
    }

    switch (type) {
      case "basket":
        return {
          ...baseData,
          definitionType: "basket",
          basketID: "",
        }
      case "protocol":
        return {
          ...baseData,
          definitionType: "protocol",
          // protocolID must be [securityLevel, protocolIDString]
          protocolID: [0, "unknown"],
        }
      case "certificate":
        return {
          ...baseData,
          definitionType: "certificate",
          type: "",
          fields: {},
        }
    }
  }, [type])

  const [formData, setFormData] = useState<DefinitionData>(getInitialFormData())
  const [certFields, setCertFields] = useState<CertField[]>([])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return

      if (e.key === "Escape") {
        onClose()
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        const form = document.querySelector("form")
        if (form) {
          form.dispatchEvent(new Event("submit", { cancelable: true }))
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    switch (type) {
      case "basket":
        formData.definitionType = "basket"
        break
      case "protocol":
        formData.definitionType = "protocol"
        break
      case "certificate": {
        const fieldsObj = certFields.reduce((acc, field) => {
          if (field.key && field.value) {
            acc[field.key] = field.value
          }
          return acc
        }, {} as Record<string, CertificateFieldDescriptor>)
        formData.definitionType = "certificate";
        (formData as CertificateDefinitionData).fields = fieldsObj
        break
      }
    }
    await onSubmit(formData)
  }

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const updateProtocolField = (target: "level" | "id", value: string) => {
    setFormData((prev: ProtocolDefinitionData) => {
      const [level, protocolIdString] = prev.protocolID as WalletProtocol
      return {
        ...prev,
        protocolID:
          target === "level"
            ? [Number(value) as SecurityLevel, protocolIdString]
            : [level, value]
      }
    })
  }

  const addCertField = () => {
    setCertFields((prev) => [
      ...prev,
      {
        key: "",
        value: {
          friendlyName: "",
          description: "",
          type: "text",
          fieldIcon: "",
        },
        isExpanded: true,
      },
    ])
  }

  const removeCertField = (index: number) => {
    setCertFields((prev) => prev.filter((_, i) => i !== index))
  }

  const updateCertField = (
    index: number,
    key: "key" | keyof CertificateFieldDescriptor,
    value: string
  ) => {
    setCertFields((prev) =>
      prev.map((field, i) => {
        if (i === index) {
          if (key === "key") {
            return { ...field, key: value }
          } else {
            return {
              ...field,
              value: { ...field.value, [key]: value },
            }
          }
        }
        return field
      })
    )
  }

  const toggleFieldExpanded = (index: number, isExpanded: boolean) => {
    setCertFields((prev) =>
      prev.map((field, i) => (i === index ? { ...field, isExpanded } : field))
    )
  }

  useEffect(() => {
    if (open) {
      if (existingData) {
        // Pre-populate form with existing data
        setFormData(existingData)

        // If certificate type, pre-populate the fields
        if (existingData.definitionType === 'certificate' && 'fields' in existingData) {
          const fields = Object.entries(existingData.fields || {}).map(([key, value]) => ({
            key,
            value,
            isExpanded: false
          }))
          setCertFields(fields)
        }
      } else {
        setFormData(getInitialFormData())
        setCertFields([])
      }
    }
  }, [open, existingData, getInitialFormData])

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[525px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? 'Update' : 'Register New'} {type.charAt(0).toUpperCase() + type.slice(1)}
          </DialogTitle>
          <DialogDescription>
            Fill in the details below to {isEditMode ? 'update' : 'register'} {isEditMode ? 'this' : 'a new'} {type} in the registry.
            Press{" "}
            <kbd className="px-2 py-1 text-xs rounded bg-muted">⌘ + Enter</kbd>{" "}
            to submit.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pr-6 -mr-6">
          <form
            id="registryForm"
            onSubmit={handleSubmit}
            className="space-y-4 pr-0"
          >
            {type === "basket" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="basketID">Basket ID</Label>
                  <Input
                    id="basketID"
                    required
                    value={'basketID' in formData ? formData.basketID : ''}
                    onChange={(e) => updateField("basketID", e.target.value)}
                    disabled={isEditMode}
                  />
                  {isEditMode && (
                    <p className="text-xs text-muted-foreground">Basket ID cannot be changed</p>
                  )}
                </div>
              </div>
            )}

            {type === "protocol" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="protocolID">Protocol ID String</Label>
                  <Input
                    id="protocolID"
                    required
                    value={'protocolID' in formData ? formData.protocolID[1] : ''}
                    onChange={(e) => updateProtocolField("id", e.target.value)}
                    disabled={isEditMode}
                  />
                  {isEditMode && (
                    <p className="text-xs text-muted-foreground">Protocol ID cannot be changed</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="protocolLevel">Security Level</Label>
                  <Select
                    value={'protocolID' in formData ? String(formData.protocolID[0]) : undefined}
                    onValueChange={(value) => updateProtocolField("level", value)}
                    disabled={isEditMode}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select security level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Level 0 (Silent)</SelectItem>
                      <SelectItem value="1">Level 1 (App)</SelectItem>
                      <SelectItem value="2">
                        Level 2 (Counterparty)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {type === "certificate" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="type">Certificate Type</Label>
                  <Input
                    id="type"
                    required
                    value={'type' in formData ? formData.type : ''}
                    onChange={(e) => updateField("type", e.target.value)}
                    disabled={isEditMode}
                  />
                  {isEditMode && (
                    <p className="text-xs text-muted-foreground">Certificate type cannot be changed</p>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center mb-2">
                    <Label>Certificate Fields</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addCertField}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Field
                    </Button>
                  </div>
                  <div className="space-y-3">
                    {certFields.map((field, index) => (
                      <Collapsible
                        key={index}
                        className="border rounded-lg group"
                        open={field.isExpanded}
                        onOpenChange={(isOpen) =>
                          toggleFieldExpanded(index, isOpen)
                        }
                      >
                        <CollapsibleTrigger className="w-full">
                          <div className="p-4 flex items-center justify-between group-hover:bg-muted/50 rounded-t-lg transition-colors">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
                                <span className="font-medium">
                                  {field.key || "New Field"}
                                </span>
                                <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-full">
                                  {field.value.type}
                                </span>
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation()
                                removeCertField(index)
                              }}
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="space-y-3 px-4 pb-4 border-t">
                            <div className="space-y-2 pt-4">
                              <Label>
                                Field Name{" "}
                                <span className="text-xs text-muted-foreground">
                                  (required)
                                </span>
                              </Label>
                              <Input
                                placeholder="e.g., certificateNumber, issueDate"
                                value={field.key}
                                onChange={(e) =>
                                  updateCertField(
                                    index,
                                    "key",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>
                                Friendly Name{" "}
                                <span className="text-xs text-muted-foreground">
                                  (how it appears in the UI)
                                </span>
                              </Label>
                              <Input
                                placeholder="e.g., Certificate Number, Issue Date"
                                value={field.value.friendlyName}
                                onChange={(e) =>
                                  updateCertField(
                                    index,
                                    "friendlyName",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>
                                Description{" "}
                                <span className="text-xs text-muted-foreground">
                                  (optional)
                                </span>
                              </Label>
                              <Textarea
                                placeholder="Describe what this field is used for"
                                value={field.value.description}
                                onChange={(e) =>
                                  updateCertField(
                                    index,
                                    "description",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Type</Label>
                              <Select
                                value={field.value.type}
                                onValueChange={(value) =>
                                  updateCertField(index, "type", value)
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select field type" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="text">Text</SelectItem>
                                  <SelectItem value="imageURL">
                                    Image URL
                                  </SelectItem>
                                  <SelectItem value="other">Other</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>
                                Field Icon{" "}
                                <span className="text-xs text-muted-foreground">
                                  (optional)
                                </span>
                              </Label>
                              <Input
                                placeholder="Icon name or URL"
                                value={field.value.fieldIcon}
                                onChange={(e) =>
                                  updateCertField(
                                    index,
                                    "fieldIcon",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    ))}
                    {certFields.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No fields added yet. Click "Add Field" to start adding certificate fields.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={formData.name || ''}
                onChange={(e) => updateField("name", e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description || ''}
                onChange={(e) => updateField("description", e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="iconURL">Icon URL</Label>
              <Input
                id="iconURL"
                value={formData.iconURL || ''}
                onChange={(e) => updateField("iconURL", e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="documentationURL">Documentation URL</Label>
              <Input
                id="documentationURL"
                type="url"
                value={formData.documentationURL || ''}
                onChange={(e) => updateField("documentationURL", e.target.value)}
              />
            </div>
          </form>
        </div>
        <DialogFooter className="mt-6">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" form="registryForm" disabled={isSubmitting}>
            {isSubmitting
              ? (isEditMode ? "Updating..." : "Registering...")
              : (isEditMode ? "Update" : "Register")
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
