import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { TableSkeleton } from "./Skeleton";
import EmptyState from "./EmptyState";

export default function DataTable({
  data,
  columns,
  pageSize = 25,
  pageSizeOptions = [10, 25, 50, 100],
  onPageChange,
  onPageSizeChange,
  currentPage = 0,
  totalPages = 1,
  totalItems = 0,
  isLoading = false,
  emptyState,
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize,
      },
    },
  });

  return (
    <div className="w-full">
      {/* Loading State */}
      {isLoading ? (
        <TableSkeleton rows={pageSize} columns={columns.length} />
      ) : data.length === 0 ? (
        /* Empty State */
        emptyState || (
          <div className="bg-white rounded-lg border border-[#eaeaea]">
            <EmptyState
              title="No data available"
              description="There are no items to display at the moment."
              size="lg"
            />
          </div>
        )
      ) : (
        <>
          {/* Table */}
          <div className="rounded-lg border border-[#eaeaea] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id} className="border-b border-[#eaeaea] bg-[#f8fafc]">
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase tracking-wider whitespace-nowrap"
                          style={{ width: header.getSize() }}
                        >
                          {header.isPlaceholder ? null : (
                            <div
                              className={`flex items-center gap-1 ${
                                header.column.getCanSort() ? "cursor-pointer select-none hover:text-[#1e293b]" : ""
                              }`}
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {header.column.getCanSort() && (
                                <span className="text-[#9e9e9e]">
                                  {header.column.getIsSorted() === "asc" ? (
                                    <ArrowUp size={14} />
                                  ) : header.column.getIsSorted() === "desc" ? (
                                    <ArrowDown size={14} />
                                  ) : (
                                    <ArrowUpDown size={14} />
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-[#eaeaea] hover:bg-[#f8fafc] transition-colors"
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-4 py-3 text-[#1e293b] whitespace-nowrap">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <div className="flex flex-col sm:flex-row items-center justify-between mt-4 px-1 gap-4">
            <div className="flex items-center gap-2 text-sm text-[#64748b]">
              <span>Showing</span>
              <select
                value={pageSize}
                onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
                className="px-2 py-1 border border-[#eaeaea] rounded-md bg-white text-[#1e293b] text-sm focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
              >
                {pageSizeOptions.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <span>of {totalItems} entries</span>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => onPageChange?.(0)}
                disabled={currentPage === 0}
                className="p-1.5 rounded-md border border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="First page"
              >
                <ChevronsLeft size={16} />
              </button>
              <button
                onClick={() => onPageChange?.(currentPage - 1)}
                disabled={currentPage === 0}
                className="p-1.5 rounded-md border border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Previous page"
              >
                <ChevronLeft size={16} />
              </button>

              <span className="px-3 py-1.5 text-sm text-[#1e293b] font-medium">
                Page {currentPage + 1} of {totalPages || 1}
              </span>

              <button
                onClick={() => onPageChange?.(currentPage + 1)}
                disabled={currentPage >= totalPages - 1}
                className="p-1.5 rounded-md border border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Next page"
              >
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() => onPageChange?.(totalPages - 1)}
                disabled={currentPage >= totalPages - 1}
                className="p-1.5 rounded-md border border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Last page"
              >
                <ChevronsRight size={16} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
