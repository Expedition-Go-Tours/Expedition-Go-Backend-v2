import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, PlusCircle, Search, Star, X } from "lucide-react";
import { toast } from "sonner";

import { useCreateTour, useTours } from "@/features/tours/hooks";
import { AdminButton } from "@/components/ui/admin-button";
import {
  AdminCard,
  AdminCardContent,
  AdminCardHeader
} from "@/components/ui/admin-card";
import { AdminInput, AdminLabel, AdminTextarea } from "@/components/ui/admin-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { extractList } from "@/utils/extractList";

const sortOptions = [
  { value: "name", label: "Sort by name" },
  { value: "price", label: "Sort by price" },
  { value: "rating", label: "Sort by rating" },
];
const STEP_FIELD_CLASS = "border-[#dbe8f8] bg-white focus:border-[#8fc3ff] focus:ring-[#8fc3ff]/25";

const defaultForm = {
  name: "",
  optionReferenceCode: `EXPMUTI-${Math.floor(1000 + Math.random() * 9000)}`,
  duration: "",
  maxGroupSize: "",
  difficulty: "medium",
  price: "",
  priceDiscount: "",
  summary: "",
  description: "",
  category: "",
  tags: "",
  itineraryDays: [],
  itineraryTitle: "",
  itineraryDescription: "",
  imageCover: null,
  images: [],
};

const CREATE_STEPS = [
  { key: "main", title: "Main Information", hint: "Required core details" },
  { key: "media", title: "Photos & Media", hint: "Cover and gallery images" },
  { key: "itinerary", title: "Itinerary", hint: "Day-by-day plan" },
  { key: "pricing", title: "Pricing & Category", hint: "Pricing and optional tags" },
  { key: "review", title: "Review & Publish", hint: "Final checks" },
];
const ALLOWED_DIFFICULTIES = new Set(["easy", "medium", "difficult"]);

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickId(tour) {
  return tour?._id || tour?.id || "draft";
}

function inferStatus(tour) {
  const reviewCount = asNumber(tour?.ratingsQuantity || tour?.reviewsCount);
  const hasSummary = Boolean(String(tour?.summary || "").trim());
  if (!hasSummary) return "Needs review";
  if (reviewCount <= 0) return "Needs review";
  return "Bookable";
}

function isStepComplete(index, form) {
  switch (index) {
    case 0:
      return Boolean(
        textValue(form.name) &&
          textValue(form.summary) &&
          textValue(form.description) &&
          parsePositiveNumber(form.duration) !== null &&
          parsePositiveNumber(form.maxGroupSize) !== null &&
          ALLOWED_DIFFICULTIES.has(String(form.difficulty || "").toLowerCase()),
      );
    case 1:
      return true;
    case 2:
      return true;
    case 3:
      return Boolean(parseNonNegativeNumber(form.price) !== null);
    case 4:
      return Boolean(
        textValue(form.name) &&
          textValue(form.summary) &&
          textValue(form.description) &&
          parsePositiveNumber(form.duration) !== null &&
          parsePositiveNumber(form.maxGroupSize) !== null &&
          ALLOWED_DIFFICULTIES.has(String(form.difficulty || "").toLowerCase()) &&
          parseNonNegativeNumber(form.price) !== null,
      );
    default:
      return false;
  }
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function textValue(value) {
  return String(value ?? "").trim();
}

function getStepValidationError(step, form) {
  switch (step) {
    case 0:
      if (!textValue(form.name)) return "Name is required";
      if (!form.duration || parsePositiveNumber(form.duration) === null) return "Duration must be a positive number";
      if (!form.maxGroupSize || parsePositiveNumber(form.maxGroupSize) === null) return "Maximum group size must be a positive number";
      if (!ALLOWED_DIFFICULTIES.has(String(form.difficulty || "").toLowerCase())) return "Difficulty must be easy, medium, or difficult";
      if (!textValue(form.summary)) return "Summary is required";
      if (!textValue(form.description)) return "Description is required";
      return null;
    case 1:
      return null;
    case 2:
      return null;
    case 3:
      if (parseNonNegativeNumber(form.price) === null) return "Price is required and must be a non-negative number";
      if (form.priceDiscount !== "" && parseNonNegativeNumber(form.priceDiscount) === null) {
        return "Price discount must be a non-negative number";
      }
      return null;
    default:
      return null;
  }
}

function buildCreateTourPayload(form) {
  const duration = parsePositiveNumber(form.duration);
  const maxGroupSize = parsePositiveNumber(form.maxGroupSize);
  const price = parseNonNegativeNumber(form.price);
  const priceDiscount = form.priceDiscount === "" ? null : parseNonNegativeNumber(form.priceDiscount);
  const difficulty = String(form.difficulty || "").toLowerCase();

  const name = textValue(form.name);
  const optionReferenceCode = textValue(form.optionReferenceCode);
  const summary = textValue(form.summary);
  const description = textValue(form.description);
  const category = textValue(form.category);
  const itineraryDays = Array.isArray(form.itineraryDays) ? form.itineraryDays : [];

  if (!name) return { error: "Name is required" };
  if (duration === null) return { error: "Duration must be a positive number" };
  if (maxGroupSize === null) return { error: "Max group size must be a positive number" };
  if (!ALLOWED_DIFFICULTIES.has(difficulty)) return { error: "Difficulty must be easy, medium, or difficult" };
  if (price === null) return { error: "Price must be a non-negative number" };
  if (!summary) return { error: "Summary is required" };
  if (!description) return { error: "Description is required" };
  if (priceDiscount !== null && priceDiscount > price) return { error: "Discount cannot be greater than price" };

  const tags = String(form.tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const formData = new FormData();
  formData.append("name", name);
  if (optionReferenceCode) formData.append("optionReferenceCode", optionReferenceCode);
  formData.append("duration", String(duration));
  formData.append("maxGroupSize", String(Math.trunc(maxGroupSize)));
  formData.append("difficulty", difficulty);
  formData.append("price", String(price));
  formData.append("summary", summary);
  formData.append("description", description);

  if (priceDiscount !== null) formData.append("priceDiscount", String(priceDiscount));
  if (category) formData.append("category", category);
  if (tags.length) {
    tags.forEach((tag) => formData.append("tags", tag));
  }
  if (itineraryDays.length) {
    const normalizedItinerary = itineraryDays
      .map((day, index) => ({
        day: index + 1,
        title: textValue(day?.title),
        description: textValue(day?.description),
      }))
      .filter((day) => day.title || day.description);
    if (normalizedItinerary.length) {
      formData.append("itinerary", JSON.stringify(normalizedItinerary));
      formData.append(
        "itineraryText",
        normalizedItinerary.map((day) => `Day ${day.day} — ${day.title}: ${day.description}`).join("\n"),
      );
    }
  }
  if (form.imageCover instanceof File) {
    formData.append("imageCover", form.imageCover);
  }
  const uniqueGallery = form.images.filter((file, idx, list) => list.findIndex((entry) => entry === file) === idx);
  uniqueGallery.forEach((file) => {
    if (file instanceof File) formData.append("images", file);
  });

  return { formData };
}

export default function CreateTourPage() {
  const galleryInputRef = useRef(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [form, setForm] = useState(defaultForm);
  const debouncedSearch = useDebouncedValue(search, 300);
  const toursQuery = useTours();
  const createTourMutation = useCreateTour();

  const tours = useMemo(() => extractList(toursQuery.data, ["tours"]), [toursQuery.data]);
  const filteredTours = useMemo(() => {
    let next = tours;
    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase();
      next = next.filter((tour) => {
        const name = String(tour?.name || "").toLowerCase();
        const reference = String(pickId(tour)).toLowerCase();
        return name.includes(term) || reference.includes(term);
      });
    }

    if (statusFilter !== "all") {
      next = next.filter((tour) => inferStatus(tour).toLowerCase() === statusFilter);
    }

    const copy = [...next];
    copy.sort((a, b) => {
      if (sortBy === "price") return asNumber(a?.price) - asNumber(b?.price);
      if (sortBy === "rating") return asNumber(b?.ratingsAverage) - asNumber(a?.ratingsAverage);
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    });
    return copy;
  }, [tours, debouncedSearch, statusFilter, sortBy]);

  const stats = useMemo(() => {
    const total = tours.length;
    const bookable = tours.filter((tour) => inferStatus(tour) === "Bookable").length;
    const needsReview = tours.filter((tour) => inferStatus(tour) === "Needs review").length;
    const ratings = tours
      .map((tour) => asNumber(tour?.ratingsAverage))
      .filter((value) => value > 0);
    const averageRating = ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : 0;
    return { total, bookable, needsReview, averageRating };
  }, [tours]);

  const completion = Math.round((completedSteps.length / CREATE_STEPS.length) * 100);
  const hasMedia = Boolean(form.imageCover || form.images.length);
  const mediaPreviewItems = form.images.length ? form.images : form.imageCover ? [form.imageCover] : [];

  function markStepAsComplete(index) {
    setCompletedSteps((prev) => (prev.includes(index) ? prev : [...prev, index]));
  }

  function validateStep(index) {
    const error = getStepValidationError(index, form);
    if (error) {
      toast.error(error);
      return false;
    }
    return true;
  }

  function handleSaveAndContinue() {
    if (!validateStep(activeStep)) return;
    markStepAsComplete(activeStep);
    setActiveStep((prev) => Math.min(prev + 1, CREATE_STEPS.length - 1));
  }

  function resetForm() {
    setForm(defaultForm);
    setActiveStep(0);
    setCompletedSteps([]);
  }

  function openCreateWizard() {
    setOpenCreate(true);
    setActiveStep(0);
  }

  function onSubmit(event) {
    event.preventDefault();
    for (let step = 0; step < CREATE_STEPS.length - 1; step += 1) {
      const stepError = getStepValidationError(step, form);
      if (stepError) {
        toast.error(stepError);
        setActiveStep(step);
        return;
      }
    }

    const { error, formData } = buildCreateTourPayload(form);
    if (error || !formData) {
      toast.error(error || "Invalid tour data");
      return;
    }

    createTourMutation.mutate(formData, {
      onSuccess: () => {
        for (let step = 0; step < CREATE_STEPS.length; step += 1) {
          markStepAsComplete(step);
        }
        resetForm();
        setOpenCreate(false);
      },
    });
  }

  function handleAddItineraryDay() {
    const title = textValue(form.itineraryTitle);
    const description = textValue(form.itineraryDescription);
    if (!title || !description) {
      toast.error("Add both itinerary title and short description");
      return;
    }
    setForm((prev) => ({
      ...prev,
      itineraryDays: [...prev.itineraryDays, { title, description }],
      itineraryTitle: "",
      itineraryDescription: "",
    }));
  }

  function handleRemoveItineraryDay(indexToRemove) {
    setForm((prev) => ({
      ...prev,
      itineraryDays: prev.itineraryDays.filter((_, index) => index !== indexToRemove),
    }));
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-4xl font-black tracking-tight text-[color:var(--admin-text)]">My Experiences</h2>
          <p className="mt-1 text-sm text-[color:var(--admin-muted)]">
            Manage, optimise and monitor every tour, transfer and activity product.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AdminButton onClick={openCreateWizard}>
            <PlusCircle className="size-4" />
            Create New Product
          </AdminButton>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminCard className="rounded-3xl">
          <AdminCardContent className="pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--admin-muted)]">Total products</p>
            <p className="mt-2 text-4xl font-black text-[color:var(--admin-text)]">{stats.total}</p>
          </AdminCardContent>
        </AdminCard>
        <AdminCard className="rounded-3xl">
          <AdminCardContent className="pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--admin-muted)]">Bookable</p>
            <p className="mt-2 text-4xl font-black text-[color:var(--admin-text)]">{stats.bookable}</p>
          </AdminCardContent>
        </AdminCard>
        <AdminCard className="rounded-3xl">
          <AdminCardContent className="pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--admin-muted)]">Needs review</p>
            <p className="mt-2 text-4xl font-black text-[color:var(--admin-text)]">{stats.needsReview}</p>
          </AdminCardContent>
        </AdminCard>
        <AdminCard className="rounded-3xl">
          <AdminCardContent className="pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--admin-muted)]">Average rating</p>
            <p className="mt-2 flex items-center gap-1 text-4xl font-black text-[color:var(--admin-text)]">
              {stats.averageRating.toFixed(1)}
              <Star className="size-6 fill-current text-amber-400" />
            </p>
          </AdminCardContent>
        </AdminCard>
      </div>

      <AdminCard className="rounded-3xl">
        <AdminCardHeader className="pb-0">
          <div className="grid w-full gap-3 lg:grid-cols-[1fr_180px_180px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--admin-muted)]" />
              <AdminInput
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search products, references or locations..."
                className="h-11 rounded-xl pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-11 rounded-xl">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="bookable">Bookable</SelectItem>
                <SelectItem value="needs review">Needs review</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="h-11 rounded-xl">
                <SelectValue placeholder="Sort by name" />
              </SelectTrigger>
              <SelectContent>
                {sortOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </AdminCardHeader>

        <AdminCardContent className="pt-4">
          <div className="overflow-hidden rounded-2xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)]">
            <div className="grid grid-cols-[minmax(260px,1.6fr)_140px_150px_170px] gap-3 border-b border-[color:var(--admin-border)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--admin-muted)]">
              <span>Product</span>
              <span>Reference</span>
              <span>Status</span>
              <span>Actions</span>
            </div>

            {toursQuery.isLoading ? (
              <div className="px-4 py-8 text-sm text-[color:var(--admin-muted)]">Loading products...</div>
            ) : filteredTours.length === 0 ? (
              <div className="px-4 py-8 text-sm text-[color:var(--admin-muted)]">No products found for current filters.</div>
            ) : (
              filteredTours.map((tour) => {
                const id = pickId(tour);
                const rating = asNumber(tour?.ratingsAverage);
                const status = inferStatus(tour);
                const cover = tour?.imageCover || tour?.image || tour?.images?.[0] || "";
                return (
                  <div
                    key={id}
                    className="grid grid-cols-[minmax(260px,1.6fr)_140px_150px_170px] gap-3 border-b border-[color:var(--admin-border)] px-4 py-4 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <div className="grid size-14 place-items-center overflow-hidden rounded-xl bg-emerald-100 text-emerald-700">
                          {cover ? (
                            <img src={cover} alt={tour?.name || "Tour cover"} className="size-full object-cover" />
                          ) : (
                            <span className="text-lg">🏛️</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-base font-bold text-[color:var(--admin-text)]">
                            {tour?.name || "Untitled tour"}
                          </p>
                          <p className="mt-1 flex items-center gap-2 text-xs text-[color:var(--admin-muted)]">
                            <span className="flex items-center gap-1 text-amber-500">
                              <Star className="size-3.5 fill-current" />
                              {rating > 0 ? rating.toFixed(1) : "N/A"}
                            </span>
                            <a
                              href={`/tour/${id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-semibold text-[color:var(--admin-info)] hover:underline"
                            >
                              Preview on website
                            </a>
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center text-sm font-semibold text-[color:var(--admin-text)]">{id}</div>
                    <div className="flex items-center">
                      <StatusPill tone={status === "Bookable" ? "success" : "warning"}>{status}</StatusPill>
                    </div>
                    <div className="flex items-center gap-2">
                      <AdminButton size="sm">See details</AdminButton>
                      <AdminButton size="sm" variant="outline" className="px-3">
                        <ChevronDown className="size-4" />
                      </AdminButton>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </AdminCardContent>
      </AdminCard>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent hideCloseButton className="max-h-[92vh] max-w-6xl overflow-y-auto p-0">
          <div className="grid gap-6 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-4xl font-black tracking-tight text-[color:var(--admin-text)]">Add New Tour Experience</h3>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-[color:var(--admin-muted)]">
                  <span>Completion: <strong className="text-[color:var(--admin-text)]">{completion}%</strong></span>
                  <span>
                    Preview: <strong className="text-[color:var(--admin-text)]">Live draft</strong>
                  </span>
                  <StatusPill tone={completion === 100 ? "success" : "info"}>
                    {completion === 100 ? "Ready" : "In progress"}
                  </StatusPill>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <AdminButton className="bg-[#10b981] text-white hover:bg-[#059669]">Save Draft</AdminButton>
                <AdminButton
                  className="bg-[#10b981] text-white hover:bg-[#059669]"
                  onClick={() => setActiveStep(CREATE_STEPS.length - 1)}
                >
                  Submit for Review
                </AdminButton>
                <button
                  type="button"
                  onClick={() => setOpenCreate(false)}
                  aria-label="Close modal"
                  className="inline-flex size-10 items-center justify-center rounded-full border border-[#dbe8f8] bg-white text-[color:var(--admin-text-soft)] transition hover:bg-[#f4f8ff]"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            <AdminCard className="rounded-3xl border-[#e7eef8] bg-white shadow-[0_10px_24px_rgba(16,24,40,0.06)]">
              <AdminCardContent className="pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-4">
                    <div className="h-20 w-32 overflow-hidden rounded-2xl border border-[#e7eef8] bg-white">
                      {form.imageCover ? (
                        <img
                          src={URL.createObjectURL(form.imageCover)}
                          alt="Hero preview"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-xs font-semibold text-[color:var(--admin-muted)]">
                          Hero image
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-[color:var(--admin-text)]">
                        {form.name || "From Accra: 5 Days Ghanaian Cultural and Heritage Tour"}
                      </p>
                      <p className="mt-2 text-sm text-[color:var(--admin-muted)]">
                        Duration: {form.duration || "0"} days • Capacity: {form.maxGroupSize || "1 - 30"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <AdminButton className="bg-[#10b981] text-white hover:bg-[#059669]">View Preview</AdminButton>
                    <AdminButton
                      className="bg-[#10b981] text-white hover:bg-[#059669]"
                      onClick={() => setActiveStep((prev) => Math.min(prev + 1, CREATE_STEPS.length - 1))}
                    >
                      Continue Setup
                    </AdminButton>
                  </div>
                </div>
                <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-[#edf3fb]">
                  <div className="h-full rounded-full bg-[color:var(--admin-info)]" style={{ width: `${completion}%` }} />
                </div>
              </AdminCardContent>
            </AdminCard>

            <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
              <AdminCard className="rounded-2xl border-[#e7eef8] bg-white shadow-[0_10px_24px_rgba(16,24,40,0.06)]">
                <AdminCardContent className="pt-5">
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-lg font-bold text-[color:var(--admin-text)]">Upload Menu</p>
                    <StatusPill tone="info">Step by step</StatusPill>
                  </div>
                  <div className="space-y-2">
                    {CREATE_STEPS.map((step, index) => {
                      const done = completedSteps.includes(index);
                      const active = activeStep === index;
                      return (
                        <button
                          key={step.key}
                          type="button"
                          onClick={() => setActiveStep(index)}
                          className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                            active
                              ? "border-[#8fc3ff] bg-white shadow-[0_4px_14px_rgba(31,132,255,0.12)]"
                              : "border-[#e7eef8] bg-white hover:bg-[#f8fbff]"
                          }`}
                        >
                          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-emerald-500 text-xs font-bold text-white">
                            {done ? <Check className="size-3.5" /> : index + 1}
                          </span>
                          <span className="min-w-0 flex-1 leading-tight">
                            <span className="block break-words text-sm font-semibold text-[color:var(--admin-text)]">{step.title}</span>
                            <span className="mt-0.5 block break-words text-xs text-[color:var(--admin-muted)]">{step.hint}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </AdminCardContent>
              </AdminCard>

              <AdminCard className="rounded-2xl border-[#e7eef8] bg-white shadow-[0_10px_24px_rgba(16,24,40,0.06)]">
                <AdminCardHeader>
                  <div>
                    <h4 className="text-xl font-bold text-[color:var(--admin-text)]">
                      Step {activeStep + 1}: {CREATE_STEPS[activeStep].title}
                    </h4>
                    <p className="mt-1 text-sm text-[color:var(--admin-muted)]">
                      {activeStep === 0 && "Enter all required tour fields marked with an asterisk."}
                      {activeStep === 1 && "Upload optional cover and gallery images."}
                      {activeStep === 2 && "Create your itinerary day by day. Add or edit stops anytime."}
                      {activeStep === 3 && "Set pricing plus optional category and tags."}
                      {activeStep === 4 && "Review required fields before publishing."}
                    </p>
                  </div>
                  <StatusPill tone="info">In progress</StatusPill>
                </AdminCardHeader>

                <AdminCardContent>
                  <form onSubmit={onSubmit} className="grid gap-4">
                    {activeStep === 0 ? (
                      <>
                        <div className="grid gap-1.5">
                          <AdminLabel htmlFor="optionReferenceCode">Option reference code</AdminLabel>
                          <AdminInput
                            id="optionReferenceCode"
                            className={STEP_FIELD_CLASS}
                            value={form.optionReferenceCode}
                            onChange={(event) => setForm((prev) => ({ ...prev, optionReferenceCode: event.target.value }))}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <AdminLabel htmlFor="name">Name *</AdminLabel>
                          <AdminInput
                            id="name"
                            className={STEP_FIELD_CLASS}
                            value={form.name}
                            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                          />
                        </div>
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="grid gap-1.5">
                            <AdminLabel htmlFor="duration">Duration (days) *</AdminLabel>
                            <AdminInput
                              id="duration"
                              className={STEP_FIELD_CLASS}
                              type="number"
                              min="1"
                              value={form.duration}
                              onChange={(event) => setForm((prev) => ({ ...prev, duration: event.target.value }))}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <AdminLabel htmlFor="maxGroupSize">Maximum group size *</AdminLabel>
                            <AdminInput
                              id="maxGroupSize"
                              className={STEP_FIELD_CLASS}
                              type="number"
                              min="1"
                              value={form.maxGroupSize}
                              onChange={(event) => setForm((prev) => ({ ...prev, maxGroupSize: event.target.value }))}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <AdminLabel htmlFor="difficulty">Difficulty *</AdminLabel>
                            <Select
                              value={form.difficulty}
                              onValueChange={(value) => setForm((prev) => ({ ...prev, difficulty: value }))}
                            >
                              <SelectTrigger id="difficulty" className={STEP_FIELD_CLASS}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="easy">easy</SelectItem>
                                <SelectItem value="medium">medium</SelectItem>
                                <SelectItem value="difficult">difficult</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div className="grid gap-1.5">
                          <AdminLabel htmlFor="summary">Summary *</AdminLabel>
                          <AdminTextarea
                            id="summary"
                            className={STEP_FIELD_CLASS}
                            rows={4}
                            value={form.summary}
                            onChange={(event) => setForm((prev) => ({ ...prev, summary: event.target.value }))}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <AdminLabel htmlFor="description">Description *</AdminLabel>
                          <AdminTextarea
                            id="description"
                            className={STEP_FIELD_CLASS}
                            rows={5}
                            value={form.description}
                            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                          />
                        </div>
                      </>
                    ) : null}

                    {activeStep === 1 ? (
                      <div className="grid gap-5">
                        <p className="text-sm text-[color:var(--admin-muted)]">
                          Upload, replace, crop, enhance and reorder photos. The first image becomes the preview hero image.
                        </p>

                        <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
                          <div className="rounded-2xl border border-dashed border-[#cbdcf8] bg-[#f4f8ff] p-5">
                            <div className="grid min-h-[170px] place-items-center text-center">
                              <div>
                                <p className="text-3xl font-bold text-[color:var(--admin-text)]">Upload Photos</p>
                                <p className="mt-2 text-sm text-[color:var(--admin-muted)]">
                                  Choose images from your computer. Recommended size: 1600 x 900px
                                </p>
                                <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                                  <AdminButton
                                    type="button"
                                    className="bg-[#1f84ff] text-white hover:bg-[#136fe0]"
                                    onClick={() => galleryInputRef.current?.click()}
                                  >
                                    Choose Files
                                  </AdminButton>
                                  <AdminButton
                                    type="button"
                                    variant="outline"
                                    className="border-[#65a9ff] text-[#1f84ff] hover:bg-[#ebf4ff]"
                                    onClick={() => {
                                      setForm((prev) => ({ ...prev, imageCover: null, images: [] }));
                                      if (galleryInputRef.current) galleryInputRef.current.value = "";
                                    }}
                                  >
                                    Clear Photos
                                  </AdminButton>
                                </div>
                                <input
                                  ref={galleryInputRef}
                                  type="file"
                                  accept="image/*"
                                  multiple
                                  className="hidden"
                                  onChange={(event) =>
                                    setForm((prev) => {
                                      const files = event.target.files ? Array.from(event.target.files) : [];
                                      if (!files.length) return prev;
                                      return {
                                        ...prev,
                                        imageCover: prev.imageCover || files[0],
                                        images: [...prev.images, ...files],
                                      };
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </div>

                          <div className={hasMedia ? "space-y-3" : "min-h-[220px]"} aria-live="polite">
                            {hasMedia
                              ? mediaPreviewItems.map((file, index) => {
                                  const isHero = form.imageCover === file;
                                  return (
                                    <div
                                      key={`${file.name}-${index}`}
                                      className="flex items-center gap-3 rounded-2xl border border-[#e7eef8] bg-white p-3"
                                    >
                                      <div className="h-14 w-20 overflow-hidden rounded-xl bg-emerald-100">
                                        <img
                                          src={URL.createObjectURL(file)}
                                          alt={`Uploaded image ${index + 1}`}
                                          className="h-full w-full object-cover"
                                        />
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-sm font-bold text-[color:var(--admin-text)]">
                                          {isHero ? "Hero Image" : `Gallery Image ${index + 1}`}
                                        </p>
                                        <p className="truncate text-xs text-[color:var(--admin-muted)]">
                                          {isHero ? "Main listing image" : "Supporting photo"}
                                        </p>
                                      </div>
                                      <AdminButton
                                        type="button"
                                        variant="outline"
                                        className="border-[#e7eef8] text-[color:var(--admin-text)]"
                                        onClick={() => setForm((prev) => ({ ...prev, imageCover: file }))}
                                      >
                                        {isHero ? "Hero" : "Set Hero"}
                                      </AdminButton>
                                    </div>
                                  );
                                })
                              : null}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-[#e7f1ff] px-3 py-1 text-xs font-semibold text-[#1f84ff]">
                            {Math.min((form.imageCover ? 1 : 0) + form.images.length, 6)} / 6 uploaded
                          </span>
                          <span className="rounded-full bg-[color:var(--admin-border-soft)] px-3 py-1 text-xs font-semibold text-[color:var(--admin-text-soft)]">
                            Vehicle photo recommended
                          </span>
                          <span className="rounded-full bg-[color:var(--admin-border-soft)] px-3 py-1 text-xs font-semibold text-[color:var(--admin-text-soft)]">
                            No blurry photos
                          </span>
                        </div>
                      </div>
                    ) : null}

                    {activeStep === 2 ? (
                      <div className="grid gap-3">
                        {(form.itineraryDays || []).map((day, index) => (
                          <div
                            key={`${day.title}-${index}`}
                            className="rounded-2xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-4"
                          >
                            <p className="text-[26px] font-bold text-[color:var(--admin-text)]">
                              Day {index + 1} — {day.title}
                            </p>
                            <p className="mt-1 text-sm text-[color:var(--admin-muted)]">{day.description}</p>
                            <AdminButton
                              type="button"
                              variant="outline"
                              className="mt-4 border-[color:var(--admin-border)] bg-[color:var(--admin-panel)]"
                              onClick={() => handleRemoveItineraryDay(index)}
                            >
                              Remove
                            </AdminButton>
                          </div>
                        ))}

                        <div className="grid gap-3 md:grid-cols-2">
                          <AdminInput
                            className={STEP_FIELD_CLASS}
                            placeholder="Day title e.g. Day 6 — Departure"
                            value={form.itineraryTitle}
                            onChange={(event) => setForm((prev) => ({ ...prev, itineraryTitle: event.target.value }))}
                          />
                          <AdminInput
                            className={STEP_FIELD_CLASS}
                            placeholder="Short description"
                            value={form.itineraryDescription}
                            onChange={(event) => setForm((prev) => ({ ...prev, itineraryDescription: event.target.value }))}
                          />
                        </div>

                        <AdminButton
                          type="button"
                          variant="outline"
                          className="border-[#65a9ff] text-[#1f84ff] hover:bg-[#ebf4ff]"
                          onClick={handleAddItineraryDay}
                        >
                          Add Itinerary Day
                        </AdminButton>
                      </div>
                    ) : null}

                    {activeStep === 3 ? (
                      <div className="grid gap-4">
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="grid gap-1.5">
                            <AdminLabel htmlFor="price">Price *</AdminLabel>
                            <AdminInput
                              id="price"
                              className={STEP_FIELD_CLASS}
                              type="number"
                              min="0"
                              step="0.01"
                              value={form.price}
                              onChange={(event) => setForm((prev) => ({ ...prev, price: event.target.value }))}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <AdminLabel htmlFor="priceDiscount">Price discount</AdminLabel>
                            <AdminInput
                              id="priceDiscount"
                              className={STEP_FIELD_CLASS}
                              type="number"
                              min="0"
                              step="0.01"
                              value={form.priceDiscount}
                              onChange={(event) => setForm((prev) => ({ ...prev, priceDiscount: event.target.value }))}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <AdminLabel htmlFor="category">Category</AdminLabel>
                            <AdminInput
                              id="category"
                              className={STEP_FIELD_CLASS}
                              value={form.category}
                              onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
                            />
                          </div>
                        </div>
                        <div className="grid gap-1.5">
                          <AdminLabel htmlFor="tags">Tags (comma separated)</AdminLabel>
                          <AdminInput
                            id="tags"
                            className={STEP_FIELD_CLASS}
                            value={form.tags}
                            onChange={(event) => setForm((prev) => ({ ...prev, tags: event.target.value }))}
                            placeholder="culture, city, historical"
                          />
                        </div>
                      </div>
                    ) : null}

                    {activeStep === 4 ? (
                      <div className="grid gap-3 rounded-2xl border border-[#e7eef8] bg-white p-4 text-sm shadow-[0_6px_20px_rgba(16,24,40,0.06)]">
                        <p className="font-semibold text-[color:var(--admin-text)]">Review checklist</p>
                        <p className="text-[color:var(--admin-muted)]">
                          Confirm required and optional fields before publishing.
                        </p>
                        <p className="text-[color:var(--admin-muted)]">
                          Required fields: name, duration, maxGroupSize, difficulty, price, summary, description.
                        </p>
                        <p className="text-[color:var(--admin-muted)]">
                          Optional fields: priceDiscount, category, tags, imageCover, images.
                        </p>
                      </div>
                    ) : null}

                    <DialogFooter className="border-t border-[color:var(--admin-border)] pt-4">
                      <div className="mr-auto">
                        <AdminButton
                          variant="outline"
                          type="button"
                          onClick={() => setActiveStep((prev) => Math.max(prev - 1, 0))}
                          disabled={activeStep === 0}
                        >
                          Back
                        </AdminButton>
                      </div>
                      <AdminButton variant="outline" type="button" onClick={resetForm} disabled={createTourMutation.isPending}>
                        Reset
                      </AdminButton>
                      {activeStep < CREATE_STEPS.length - 1 ? (
                        <AdminButton
                          type="button"
                          className="bg-[#10b981] text-white hover:bg-[#059669]"
                          onClick={handleSaveAndContinue}
                        >
                          Save & Continue
                        </AdminButton>
                      ) : (
                        <AdminButton
                          type="submit"
                          className="bg-[#10b981] text-white hover:bg-[#059669]"
                          disabled={createTourMutation.isPending}
                        >
                          {createTourMutation.isPending ? "Publishing..." : "Publish"}
                        </AdminButton>
                      )}
                    </DialogFooter>
                  </form>
                </AdminCardContent>
              </AdminCard>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
