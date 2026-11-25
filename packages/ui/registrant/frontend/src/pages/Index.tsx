
import { act, useEffect, useState, useMemo, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Plus, PackageSearch, LogOut } from "lucide-react";
import { RegistryCard } from "@/components/RegistryCard";
import { RegistryForm } from "@/components/RegistryForm";
import { DefinitionData, DefinitionType, RegistryClient, RegistryRecord, LookupResolver } from '@bsv/sdk'
import { useAuth } from "@/contexts/AuthContext";

const Index = () => {
  const { toast } = useToast();
  const { auth, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<DefinitionType>("basket");
  const [currentUser, setCurrentUser] = useState('unknown')
  const [items, setItems] = useState<RegistryRecord[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<RegistryRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [revokingItemId, setRevokingItemId] = useState<string | null>(null);

  // Ensure wallet is available and create RegistryClient only when wallet changes
  const { wallet, client } = useMemo(() => {
    const wallet = auth.wallet;
    if (!wallet) {
      return { wallet: null, client: null };
    }

    try {
      const client = new RegistryClient(wallet, {
        acceptDelayedBroadcast: false,
        resolver: new LookupResolver({
          hostOverrides: {
            'ls_slap': ['https://users.bapp.dev'],
            'ls_ship': ['https://users.bapp.dev']
          }
        })
      });
      return { wallet, client };
    } catch (error) {
      console.error('Failed to create RegistryClient:', error);
      toast({
        title: "Wallet Error",
        description: "Failed to initialize wallet client. Please try logging in again.",
        variant: "destructive",
      });
      return { wallet: null, client: null };
    }
  }, [auth.wallet, toast]);

  const loadItems = useCallback(async () => {
    if (!client) {
      setIsLoading(false);
      return;
    }

    try {
      console.log('active tab', activeTab)
      const records = await client.listOwnRegistryEntries(activeTab);
      console.log('R', records)
      setItems(records);
    } catch (error) {
      toast({
        title: "Error loading items",
        description: "Failed to load registry items. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [client, activeTab, toast]);

  useEffect(() => {
    (async () => {
      if (currentUser === 'unknown' && wallet) {
        try {
          setCurrentUser((await wallet.getPublicKey({ identityKey: true })).publicKey)
        } catch (error) {
          console.error('Failed to get public key:', error);
        }
      }
    })()
    setIsLoading(true);
    loadItems();
  }, [activeTab, wallet, currentUser, loadItems]);

  const handleRegister = async (formData: DefinitionData) => {
    if (!client) {
      toast({
        title: "Wallet Error",
        description: "Wallet client not available. Please try logging in again.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await client.registerDefinition(formData);
      setIsFormOpen(false);
      toast({
        title: "Success",
        description: "Item registered successfully",
      });
      loadItems();
    } catch (error) {
      toast({
        title: "Registration failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdate = async (formData: DefinitionData) => {
    if (!client || !editingItem) {
      toast({
        title: "Error",
        description: "Cannot update: missing client or item data.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await client.updateDefinition(editingItem, formData);
      setIsFormOpen(false);
      setEditingItem(null);
      toast({
        title: "Success",
        description: "Item updated successfully",
      });
      loadItems();
    } catch (error) {
      toast({
        title: "Update failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (item: RegistryRecord) => {
    setEditingItem(item);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingItem(null);
  };

  const handleRevoke = async (item: RegistryRecord) => {
    if (!client) {
      toast({
        title: "Wallet Error",
        description: "Wallet client not available. Please try logging in again.",
        variant: "destructive",
      });
      return;
    }

    setRevokingItemId(item.txid!);
    try {
      await client.removeDefinition(item);
      toast({
        title: "Success",
        description: "Item revoked successfully",
      });
      loadItems();
    } catch (error) {
      toast({
        title: "Revoke failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setRevokingItemId(null);
    }
  };

  const renderContent = () => {
    if (!wallet || !client) {
      return (
        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
          <PackageSearch className="h-12 w-12 mb-4" />
          <p>Wallet not available</p>
          <p className="text-sm mt-2 text-center px-4">Please ensure your wallet is properly connected and try logging in again</p>
        </div>
      );
    }

    if (isLoading) {
      return (
        <div className="flex items-center justify-center h-48">
          <div className="animate-pulse space-y-4">
            <div className="h-12 w-64 bg-muted rounded"></div>
            <div className="h-12 w-48 bg-muted rounded"></div>
          </div>
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
          <PackageSearch className="h-12 w-12 mb-4" />
          <p>No items registered yet</p>
          <p className="text-sm mt-2 text-center px-4">Click the "Register New" button above to get started</p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {items.map((item) => (
          <RegistryCard
            key={item.txid}
            item={item}
            onRevoke={() => handleRevoke(item)}
            onEdit={() => handleEdit(item)}
            isRevoking={revokingItemId === item.txid}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="container max-w-5xl mx-auto py-4 sm:py-8 px-4 min-h-screen animate-fade-in overflow-x-hidden">
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-8">
        <div className="space-y-2 sm:space-y-4">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Registrant</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Register and manage your entries for baskets, protocols, and certificate types.
          </p>
        </div>
        <Button variant="ghost" onClick={logout} className="text-muted-foreground self-end sm:self-start">
          <LogOut className="mr-2 h-4 w-4" />
          Logout
        </Button>
        {/* <IdentityCard identityKey={currentUser} /> */}
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DefinitionType)} className="space-y-6">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 sm:gap-0 sm:justify-between">
          <TabsList className="w-full sm:w-[400px]">
            <TabsTrigger value="basket" className="flex-1">Baskets</TabsTrigger>
            <TabsTrigger value="protocol" className="flex-1">Protocols</TabsTrigger>
            <TabsTrigger value="certificate" className="flex-1">Certificates</TabsTrigger>
          </TabsList>
          <Button
            onClick={() => setIsFormOpen(true)}
            disabled={!wallet || !client}
            size={items.length === 0 ? "lg" : "default"}
            className={`w-full sm:w-auto ${items.length === 0 ? "animate-pulse" : ""}`}
          >
            <Plus className="mr-2 h-4 w-4" />
            Register New
          </Button>
        </div>

        <TabsContent value="basket" className="mt-6">
          {renderContent()}
        </TabsContent>

        <TabsContent value="protocol" className="mt-6">
          {renderContent()}
        </TabsContent>

        <TabsContent value="certificate" className="mt-6">
          {renderContent()}
        </TabsContent>
      </Tabs>
      <RegistryForm
        type={activeTab}
        open={isFormOpen}
        onClose={handleCloseForm}
        onSubmit={editingItem ? handleUpdate : handleRegister}
        existingData={editingItem || undefined}
        isSubmitting={isSubmitting}
      />
    </div>
  );
};

export default Index;
